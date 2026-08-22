// Compiled connector kinds. Catalog presence is vocabulary, not authority: no
// adapter, credential, service or attachment is created from this file.

const op = (id, label, mode) => Object.freeze({ id, label, mode });
const kind = (label, family, egressHosts, operations, maturity = "reserved") =>
  Object.freeze({ label, family, egressHosts: Object.freeze(egressHosts), operations: Object.freeze(operations), maturity });

export const CONNECTOR_CATALOG = Object.freeze({
  "google-gmail": kind("Gmail", "Google Workspace", ["gmail.googleapis.com", "oauth2.googleapis.com"], [
    op("messages.list", "List messages", "read"),
    op("messages.read", "Read a message", "read"),
    op("drafts.propose", "Propose a draft", "propose"),
  ], "legacy-precedent"),
  "google-calendar-read": kind("Google Calendar (read)", "Google Workspace", ["www.googleapis.com", "oauth2.googleapis.com"], [
    op("events.list", "List events", "read"),
    op("events.read", "Read an event", "read"),
  ], "legacy-precedent"),
  "google-calendar-write": kind("Google Calendar (approval writes)", "Google Workspace", ["www.googleapis.com", "oauth2.googleapis.com"], [
    op("events.create.propose", "Propose an event", "propose"),
    op("events.update.propose", "Propose an event change", "propose"),
    op("events.create.apply", "Create an approved event", "apply"),
    op("events.update.apply", "Apply an approved event change", "apply"),
  ], "legacy-precedent"),
  "google-drive": kind("Google Drive", "Google Workspace", ["www.googleapis.com", "oauth2.googleapis.com"], [
    op("files.list", "List files", "read"), op("files.read", "Read file metadata or content", "read"),
  ]),
  "google-docs": kind("Google Docs", "Google Workspace", ["docs.googleapis.com", "oauth2.googleapis.com"], [
    op("documents.read", "Read a document", "read"), op("documents.update.propose", "Propose document edits", "propose"),
  ]),
  "google-sheets": kind("Google Sheets", "Google Workspace", ["sheets.googleapis.com", "oauth2.googleapis.com"], [
    op("spreadsheets.read", "Read spreadsheet ranges", "read"), op("spreadsheets.update.propose", "Propose cell updates", "propose"),
  ]),
  "google-tasks": kind("Google Tasks", "Google Workspace", ["tasks.googleapis.com", "oauth2.googleapis.com"], [
    op("tasks.list", "List tasks", "read"), op("tasks.update.propose", "Propose a task change", "propose"),
  ]),
  "google-people": kind("Google Contacts", "Google Workspace", ["people.googleapis.com", "oauth2.googleapis.com"], [
    op("contacts.list", "List contacts", "read"), op("contacts.read", "Read contact details", "read"),
  ]),
  "microsoft-outlook-mail": kind("Outlook Mail", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("messages.list", "List messages", "read"), op("messages.read", "Read a message", "read"),
    op("drafts.propose", "Propose a draft", "propose"),
  ]),
  "microsoft-calendar-read": kind("Outlook Calendar (read)", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("events.list", "List events", "read"), op("events.read", "Read an event", "read"),
  ]),
  "microsoft-calendar-write": kind("Outlook Calendar (approval writes)", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("events.create.propose", "Propose an event", "propose"),
    op("events.update.propose", "Propose an event change", "propose"),
    op("events.create.apply", "Create an approved event", "apply"),
    op("events.update.apply", "Apply an approved event change", "apply"),
  ]),
  "microsoft-onedrive": kind("OneDrive", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("files.list", "List files", "read"), op("files.read", "Read a file", "read"),
    op("files.write.propose", "Propose a file write", "propose"),
  ]),
  "microsoft-sharepoint": kind("SharePoint", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("sites.list", "List sites", "read"), op("content.read", "Read site content", "read"),
  ]),
  "microsoft-excel": kind("Excel workbooks", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("workbooks.read", "Read workbook ranges", "read"), op("workbooks.update.propose", "Propose workbook updates", "propose"),
  ]),
  "microsoft-todo": kind("Microsoft To Do", "Microsoft 365", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("tasks.list", "List tasks", "read"), op("tasks.read", "Read a task", "read"),
    op("tasks.update.propose", "Propose a task change", "propose"),
  ]),
  dropbox: kind("Dropbox", "Files and knowledge", ["api.dropboxapi.com", "content.dropboxapi.com"], [
    op("files.list", "List files", "read"), op("files.read", "Read a file", "read"), op("files.write.propose", "Propose a file write", "propose"),
  ]),
  box: kind("Box", "Files and knowledge", ["api.box.com", "upload.box.com"], [
    op("files.list", "List files", "read"), op("files.read", "Read a file", "read"),
  ]),
  notion: kind("Notion", "Files and knowledge", ["api.notion.com"], [
    op("pages.search", "Search pages", "read"), op("pages.read", "Read a page", "read"), op("pages.update.propose", "Propose a page update", "propose"),
  ]),
  airtable: kind("Airtable", "Files and knowledge", ["api.airtable.com"], [
    op("records.list", "List records", "read"), op("records.read", "Read a record", "read"), op("records.update.propose", "Propose record changes", "propose"),
  ]),
  basecamp: kind("Basecamp", "Projects and collaboration", ["3.basecampapi.com", "launchpad.37signals.com"], [
    op("projects.list", "List projects", "read"), op("todos.list", "List to-dos", "read"), op("todos.update.propose", "Propose a to-do change", "propose"),
  ]),
  github: kind("GitHub", "Projects and collaboration", ["api.github.com"], [
    op("issues.list", "List issues", "read"), op("issues.read", "Read an issue", "read"), op("issues.comment.propose", "Propose an issue comment", "propose"),
  ]),
  linear: kind("Linear", "Projects and collaboration", ["api.linear.app"], [
    op("issues.list", "List issues", "read"), op("issues.read", "Read an issue", "read"), op("issues.update.propose", "Propose an issue change", "propose"),
  ]),
  asana: kind("Asana", "Projects and collaboration", ["app.asana.com"], [
    op("tasks.list", "List tasks", "read"), op("tasks.read", "Read a task", "read"), op("tasks.update.propose", "Propose a task change", "propose"),
  ]),
  trello: kind("Trello", "Projects and collaboration", ["api.trello.com"], [
    op("cards.list", "List cards", "read"), op("cards.read", "Read a card", "read"), op("cards.update.propose", "Propose a card change", "propose"),
  ]),
  slack: kind("Slack", "Projects and collaboration", ["slack.com"], [
    op("messages.search", "Search messages", "read"), op("messages.read", "Read channel history", "read"), op("messages.post.propose", "Propose a message", "propose"),
  ]),
  discord: kind("Discord", "Projects and collaboration", ["discord.com"], [
    op("messages.read", "Read allowed channel history", "read"), op("messages.post.propose", "Propose a message", "propose"),
  ]),
  "microsoft-teams": kind("Microsoft Teams", "Projects and collaboration", ["graph.microsoft.com", "login.microsoftonline.com"], [
    op("messages.read", "Read allowed channel history", "read"), op("messages.post.propose", "Propose a message", "propose"),
  ]),
  linkedin: kind("LinkedIn", "Professional presence", ["api.linkedin.com", "www.linkedin.com"], [
    op("profile.self.read", "Read the authenticated member profile", "read"),
    op("posts.owned.read", "Read owned posts", "read"),
    op("posts.publish.propose", "Propose a post", "propose"),
  ]),
  todoist: kind("Todoist", "Personal work", ["api.todoist.com"], [
    op("tasks.list", "List tasks", "read"), op("tasks.read", "Read a task", "read"), op("tasks.update.propose", "Propose a task change", "propose"),
  ]),
  caldav: kind("CalDAV / CardDAV", "Personal work", [], [
    op("items.list", "List allowed items", "read"), op("items.read", "Read an item", "read"), op("items.update.propose", "Propose an item change", "propose"),
  ]),
  "imap-mail": kind("IMAP mail (read/draft)", "Personal work", [], [
    op("messages.list", "List messages", "read"), op("messages.read", "Read a message", "read"),
    op("drafts.propose", "Propose a draft", "propose"),
  ]),
  stripe: kind("Stripe reporting", "Business data", ["api.stripe.com"], [
    op("balance.read", "Read balances", "read"), op("customers.read", "Read customer summaries", "read"), op("invoices.list", "List invoices", "read"),
  ]),
});

export const OPERATION_MODES = Object.freeze(["local", "read", "propose", "apply"]);

export function connectorCatalogView() {
  return Object.entries(CONNECTOR_CATALOG).map(([id, entry]) => ({
    id,
    label: entry.label,
    family: entry.family,
    maturity: entry.maturity,
    egressHosts: [...entry.egressHosts],
    operations: entry.operations.map((operation) => ({ ...operation })),
  }));
}

export function catalogKind(id) {
  return Object.hasOwn(CONNECTOR_CATALOG, id) ? CONNECTOR_CATALOG[id] : null;
}
