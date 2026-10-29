// One-way Project Status sync (node stdlib only, no new deps).
//
// Source of truth: user project NDTruongDanh/projects/3 ("SE373 Member Tasks").
// Mirror: org project se373agenticengineering/projects/32 ("Nhóm 32 — Analytics Agent"),
// which is the project linked to the teacher repo se373agenticengineering/nhom-32.
//
// GitHub cannot formally link a user-owned project to an org-owned repo
// ("Only projects owned by the same owner as the repository can be linked"),
// so this script copies *item membership + Status* instead:
//   1. every Issue/PR in the source project is added to the target project (same issue, no duplicates),
//   2. the target Status is set to match the source Status.
//
// Status is per (project, item), so keeping two boards aligned always needs
// a sync like this. Issue open/closed state is global and needs no sync.
//
// Usage:
//   node scripts/sync-project-status.mjs            # dry-run (default, read-only)
//   node scripts/sync-project-status.mjs --apply   # perform adds + status updates
//
// Auth (first non-empty wins):
//   PROJECT_SYNC_TOKEN, GH_TOKEN, GITHUB_TOKEN
// The token needs `project` scope (classic PAT) or Projects read+write
// (fine-grained) plus repo read for the source issues. GITHUB_TOKEN from
// Actions cannot be relied on for cross-owner Projects writes, so the
// workflow uses a PAT stored as the PROJECT_SYNC_TOKEN secret (same pattern
// as TEACHER_SYNC_TOKEN in sync-to-teacher.yml).
//
// Exit 0 on success (including dry-run with pending changes), 1 on API/config errors.

const API = "https://api.github.com/graphql";

const SOURCE = {
  login: process.env.SOURCE_LOGIN || "NDTruongDanh",
  number: Number(process.env.SOURCE_NUMBER || 3),
};
const TARGET = {
  login: process.env.TARGET_LOGIN || "se373agenticengineering",
  number: Number(process.env.TARGET_NUMBER || 32),
};

// Source has Todo/In Progress/In Review/Done; target has Todo/In Progress/Done.
const STATUS_MAP = {
  Todo: "Todo",
  "In Progress": "In Progress",
  "In Review": "In Progress",
  Done: "Done",
};

const APPLY = process.argv.includes("--apply");

function token() {
  const t =
    process.env.PROJECT_SYNC_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    "";
  if (!t) {
    console.error(
      "Missing token: set PROJECT_SYNC_TOKEN (preferred), GH_TOKEN, or GITHUB_TOKEN.",
    );
    process.exit(1);
  }
  return t;
}

async function gql(query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (data.errors?.length) {
    throw new Error(`GraphQL: ${JSON.stringify(data.errors).slice(0, 1000)}`);
  }
  return data.data;
}

const PROJECT_QUERY = `
query GetProject($login: String!, $number: Int!, $after: String) {
  owner: repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) { ...Proj }
    }
  }
}
fragment Proj on ProjectV2 {
  id title url
  statusField: field(name: "Status") {
    ... on ProjectV2SingleSelectField { id options { id name } }
  }
  items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      content {
        __typename
        ... on Issue { id number title url state }
        ... on PullRequest { id number title url state }
        ... on DraftIssue { id title }
      }
      status: fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
      }
    }
  }
}`;

async function fetchProject(login, number) {
  let after = null;
  let proj = null;
  const nodes = [];
  for (;;) {
    const data = await gql(PROJECT_QUERY, { login, number, after });
    const p = data?.owner?.projectV2 ?? null;
    if (!p) throw new Error(`Project not found: ${login}/projects/${number}`);
    proj = { id: p.id, title: p.title, url: p.url, statusField: p.statusField };
    nodes.push(...p.items.nodes);
    if (!p.items.pageInfo.hasNextPage) break;
    after = p.items.pageInfo.endCursor;
  }
  return { ...proj, items: nodes };
}

async function addItem(projectId, contentId) {
  const data = await gql(
    `mutation AddItem($projectId: ID!, $contentId: ID!) {
       addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
     }`,
    { projectId, contentId },
  );
  return data.addProjectV2ItemById.item.id;
}

async function setStatus(projectId, itemId, fieldId, optionId) {
  await gql(
    `mutation SetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
       updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } }
     }`,
    { projectId, itemId, fieldId, optionId },
  );
}

const keyOf = (content) =>
  content?.id ?? (content?.url ? `url:${content.url}` : null);

const labelOf = (content) =>
  content?.url ??
  (content?.title ? `draft:${content.title.slice(0, 60)}` : "(empty item)");

const s = process.argv.includes("--help") || process.argv.includes("-h");
if (s) {
  console.log(
    "Usage: node scripts/sync-project-status.mjs [--apply]\nDefault is dry-run; --apply writes adds + status updates.",
  );
  process.exit(0);
}

const source = await fetchProject(SOURCE.login, SOURCE.number);
const target = await fetchProject(TARGET.login, TARGET.number);

if (!source.statusField?.id) throw new Error("Source project has no Status field");
if (!target.statusField?.id) throw new Error("Target project has no Status field");
const targetOptions = new Map(
  (target.statusField.options ?? []).map((o) => [o.name, o.id]),
);

const targetByKey = new Map();
for (const item of target.items) {
  const k = keyOf(item.content);
  if (k) targetByKey.set(k, item);
}

let added = 0;
let updated = 0;
let inSync = 0;
let skipped = 0;

for (const src of source.items) {
  const content = src.content;
  const k = keyOf(content);
  const label = labelOf(content);
  if (!k || !content?.id) {
    skipped += 1;
    console.log(`SKIP (no cross-project id, likely draft): ${label}`);
    continue;
  }
  const srcStatus = src.status?.name ?? null;
  const wantName = srcStatus ? (STATUS_MAP[srcStatus] ?? null) : null;

  let tgt = targetByKey.get(k);
  if (!tgt) {
    if (!APPLY) {
      console.log(`WOULD_ADD: ${label}`);
      if (wantName) console.log(`WOULD_SET ${wantName}: ${label}`);
      else if (srcStatus && !STATUS_MAP[srcStatus]) {
        skipped += 1;
        console.log(`SKIP (unmapped source status "${srcStatus}"): ${label}`);
      }
      continue;
    }
    const newId = await addItem(target.id, content.id);
    tgt = { id: newId, status: null };
    targetByKey.set(k, tgt);
    added += 1;
    console.log(`ADD: ${label}`);
  }
  if (!wantName) {
    if (srcStatus && !STATUS_MAP[srcStatus]) {
      skipped += 1;
      console.log(`SKIP (unmapped source status "${srcStatus}"): ${label}`);
    } else {
      inSync += 1;
    }
    continue;
  }
  const wantOptionId = targetOptions.get(wantName);
  if (!wantOptionId) {
    skipped += 1;
    console.log(`SKIP (target has no "${wantName}" option): ${label}`);
    continue;
  }
  const currentName = tgt.status?.name ?? null;
  if (currentName === wantName) {
    inSync += 1;
    continue;
  }
  if (!APPLY) {
    console.log(`WOULD_SET ${wantName} (was ${currentName ?? "unset"}): ${label}`);
  } else {
    await setStatus(target.id, tgt.id, target.statusField.id, wantOptionId);
    tgt.status = { name: wantName, optionId: wantOptionId };
    updated += 1;
    console.log(`SET ${wantName} (was ${currentName ?? "unset"}): ${label}`);
  }
}

console.log(
  `\n${APPLY ? "apply" : "dry-run"} done: source=${source.items.length} target_known=${target.items.length} added=${added} status_updates=${updated} in_sync=${inSync} skipped=${skipped}`,
);
console.log(`source: ${source.url}\ntarget: ${target.url}`);
