#!/usr/bin/env bash
# ORDERLY Linux/WSL lane wrapper.
#
# Contract: lane-run.sh NAME WORKDIR LOGFILE TIMEOUT -- CMD...
# The command gets a new session/process group. The .done sentinel is touched
# only after TERM -> KILL has swept that group; it never means success.

set -u

if [[ "$#" -lt 6 ]]; then
  echo "usage: lane-run.sh NAME WORKDIR LOGFILE TIMEOUT -- CMD..." >&2
  exit 64
fi

name=$1
workdir=$2
logfile=$3
timeout_s=$4
shift 4
if [[ "$1" != "--" ]]; then
  echo "lane-run.sh: expected -- before the fixed command" >&2
  exit 64
fi
shift
if [[ "$#" -eq 0 || ! "$timeout_s" =~ ^[1-9][0-9]*$ ]]; then
  echo "lane-run.sh: command and positive integer timeout required" >&2
  exit 64
fi

mkdir -p "$(dirname "$logfile")"

# fd 3 preserves the broker's brief-file stream. Python's own source arrives
# through the heredoc on stdin; the worker receives fd 3 as its stdin.
exec python3 - "$name" "$workdir" "$logfile" "$timeout_s" "$@" 3<&0 <<'PY'
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

name, workdir, logfile, timeout_raw, *command = sys.argv[1:]
timeout_s = int(timeout_raw)
stem = logfile[:-4] if logfile.endswith(".log") else logfile
done_path = Path(stem + ".done")
exit_path = Path(stem + ".exit")
pgid_path = Path(stem + ".pgid")
sweep_path = Path(stem + ".sweep")
timeout_path = Path(stem + ".timeout")
stopping_signal = None

def note_signal(number, _frame):
    global stopping_signal
    stopping_signal = number

for watched in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(watched, note_signal)

def group_alive(pgid):
    # Match the host watcher and probe the process group, not merely its leader.
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    result = subprocess.run(
        ["pgrep", "-g", str(pgid)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    # pgrep status 1 is a clean "no matches". An inability to inspect the
    # process list is not evidence of death; fail closed and sweep.
    return result.returncode != 1

def sweep(pgid, log, leader):
    def alive():
        # Reap the group leader as soon as it exits. Otherwise pgrep correctly
        # sees a zombie which this parent itself is keeping around and a clean
        # TERM can be misreported as a live process group forever.
        leader.poll()
        return group_alive(pgid)

    if not alive():
        result = "group-already-dead"
        log.write(f"[orderly] sweep {pgid}: {result}\n")
        log.flush()
        return result
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return "group-already-dead"
    except PermissionError:
        log.write(f"[orderly] sweep {pgid}: TERM permission denied\n")
        log.flush()
        return "group-still-live-term-permission-denied"
    log.write(f"[orderly] sweep {pgid}: TERM sent\n")
    log.flush()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and alive():
        time.sleep(0.1)
    if not alive():
        result = "term-swept"
        log.write(f"[orderly] sweep {pgid}: {result}\n")
        log.flush()
        return result
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        result = "term-swept"
        log.write(f"[orderly] sweep {pgid}: {result}\n")
        log.flush()
        return result
    except PermissionError:
        result = "group-still-live-after-kill-permission-denied"
        log.write(f"[orderly] sweep {pgid}: {result}\n")
        log.flush()
        return result
    log.write(f"[orderly] sweep {pgid}: KILL sent\n")
    log.flush()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and alive():
        time.sleep(0.1)
    result = "group-still-live-after-kill" if alive() else "kill-swept"
    log.write(f"[orderly] sweep {pgid}: {result}\n")
    log.flush()
    return result

Path(logfile).parent.mkdir(parents=True, exist_ok=True)
status = 70
pgid = None
proc = None
with open(logfile, "a", buffering=1, encoding="utf8") as raw_log:
    raw_log.write(f"[orderly] lane {name} starting\n")
    try:
        worker_stdin = os.fdopen(3, "rb", closefd=False)
        proc = subprocess.Popen(
            command,
            cwd=workdir,
            stdin=worker_stdin,
            stdout=raw_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
        pgid = proc.pid
        temporary = Path(str(pgid_path) + f".tmp-{os.getpid()}")
        temporary.write_text(f"{pgid}\n", encoding="ascii")
        os.replace(temporary, pgid_path)
        started = time.monotonic()
        timed_out = False
        while proc.poll() is None:
            if stopping_signal is not None:
                break
            if time.monotonic() - started >= timeout_s:
                timed_out = True
                timeout_path.write_text("timed-out\n", encoding="ascii")
                break
            time.sleep(0.1)
        if proc.poll() is not None:
            status = 128 + (-proc.returncode) if proc.returncode < 0 else proc.returncode
        elif timed_out:
            status = 124
        elif stopping_signal is not None:
            status = 128 + stopping_signal
    except Exception as error:
        raw_log.write(f"[orderly] wrapper error: {type(error).__name__}: {error}\n")
        status = 70
    finally:
        result = "no-process-group-created"
        if pgid is not None and proc is not None:
            result = sweep(pgid, raw_log, proc)
        sweep_path.write_text(result + "\n", encoding="utf8")
        exit_path.write_text(f"{status}\n", encoding="ascii")
        raw_log.write(f"[orderly] lane {name} exit code {status}\n")
        raw_log.write("[orderly] sentinel follows completed group sweep\n")
        done_path.touch()

raise SystemExit(status)
PY
