# Broker seat response contract

Return exactly one JSON object and no Markdown. Every response requires a
`decision` and a non-empty `rationale`.

`decision` must be one of `dispatch`, `clarify`, `refuse`, `cancel`, or `hold`.

A `dispatch` response also requires a `brief` object with all of these fields:

```json
{
  "repo": "<allowlisted repository id>",
  "base_sha": "<trusted base commit>",
  "files_in_scope": [],
  "files_forbidden": [],
  "acceptance_checks": [],
  "lane_preset": "<allowlisted preset id>",
  "timeout_s": 1,
  "no_integration": true
}
```

The three scope/check fields are arrays, `timeout_s` is a positive integer, and
`no_integration` is the literal boolean `true`. A `clarify` response requires a
`questions` array. A `hold` response requires a non-empty `reason` and a
`blocking_lane` that is either a non-empty string or `null`.

When present, `report` is an object whose `terminal_class` is `exit-zero`,
`failed`, `timed-out`, `process-unclean`, `no-op`, or `null`.
