import fs from "node:fs/promises";
import path from "node:path";

import {
  ClickUpClient
} from "./lib/clickup-client.mjs";

import {
  normalizeWorkspace,
  normalizeSpace,
  normalizeFolder,
  normalizeList,
  normalizeTask
} from "./lib/normalize.mjs";

import {
  getParentFolderId,
  parseBoolean,
  pathExists,
  replaceDirectoryAtomically,
  requireEnvironmentVariable,
  sha256,
  stableSortObject,
  writeJson
} from "./lib/utilities.mjs";

const startedAt = new Date();

const clickUpToken =
  requireEnvironmentVariable(
    "CLICKUP_API_TOKEN"
  );

const spaceId =
  requireEnvironmentVariable(
    "CLICKUP_SPACE_ID"
  );

const includeArchived =
  parseBoolean(
    process.env.CLICKUP_INCLUDE_ARCHIVED,
    false
  );

const includeClosed =
  parseBoolean(
    process.env.CLICKUP_INCLUDE_CLOSED,
    true
  );

const includeSubtasks =
  parseBoolean(
    process.env.CLICKUP_INCLUDE_SUBTASKS,
    true
  );

const maxRetries = Number(
  process.env.CLICKUP_MAX_RETRIES ?? 4
);

const requestDelayMs = Number(
  process.env.CLICKUP_REQUEST_DELAY_MS ?? 125
);

const runId =
  process.env.GITHUB_RUN_ID ??
  `${Date.now()}-${process.pid}`;

const archiveRoot =
  process.env.CLICKUP_ARCHIVE_ROOT ??
  "archive/workspaces";

const temporaryRoot = path.join(
  ".tmp",
  `clickup-${runId}`
);

const auditDirectory = ".audit";
const auditPath = path.join(
  auditDirectory,
  "last-run.json"
);

const statistics = {
  workspaces: 0,
  spaces: 0,

  top_level_folders: 0,
  subfolders: 0,

  folderless_lists: 0,
  lists: 0,

  tasks: 0,
  subtasks: 0,

  api_requests: 0,
  api_retries: 0,

  warnings: []
};

const client = new ClickUpClient({
  token: clickUpToken,
  maxRetries,
  requestDelayMs
});

await fs.rm(
  temporaryRoot,
  {
    recursive: true,
    force: true
  }
);

await fs.mkdir(
  temporaryRoot,
  {
    recursive: true
  }
);

await fs.mkdir(
  auditDirectory,
  {
    recursive: true
  }
);

try {
  const workspaces =
    await client.getAuthorizedWorkspaces();

  statistics.workspaces =
    workspaces.length;

  if (workspaces.length === 0) {
    throw new Error(
      "The authenticated ClickUp token has access to zero Workspaces."
    );
  }

  /*
   * Determine which authorized Workspace contains the
   * requested Space. GET /space/{space_id} does not
   * necessarily provide the Workspace ID, so discover
   * the relationship through each authorized Workspace.
   */
  let workspace = null;
  let discoveredSpace = null;

  for (const candidateWorkspace of workspaces) {
    const candidateWorkspaceId =
      String(candidateWorkspace.id);

    console.log(
      `Searching Workspace ${candidateWorkspace.name} (${candidateWorkspaceId}) for Space ${spaceId}...`
    );

    const spaces =
      await client.getSpaces(
        candidateWorkspaceId,
        {
          archived: true
        }
      );

    const match = spaces.find(
      candidateSpace =>
        String(candidateSpace.id) ===
        String(spaceId)
    );

    if (match) {
      workspace = candidateWorkspace;
      discoveredSpace = match;
      break;
    }
  }

  if (!workspace) {
    throw new Error(
      [
        `Space ${spaceId} was not found in any`,
        `Workspace authorized for this ClickUp token.`
      ].join(" ")
    );
  }

  const workspaceId =
    String(workspace.id);

  /*
   * Retrieve the full Space object after establishing
   * its parent Workspace.
   */
  const space =
    await client.getSpace(spaceId);

  statistics.spaces = 1;

  console.log(
    `Found Space ${space.name ?? discoveredSpace.name} (${spaceId})`
  );

  console.log(
    `Parent Workspace: ${workspace.name} (${workspaceId})`
  );

  const workspaceTemporaryPath =
    path.join(
      temporaryRoot,
      workspaceId
    );

  const spaceTemporaryPath =
    path.join(
      workspaceTemporaryPath,
      "spaces",
      spaceId
    );

  await writeJson(
    path.join(
      workspaceTemporaryPath,
      "workspace.json"
    ),
    normalizeWorkspace(workspace)
  );

  await writeJson(
    path.join(
      spaceTemporaryPath,
      "space.json"
    ),
    normalizeSpace(
      space,
      workspaceId
    )
  );

  /*
   * ClickUp returns top-level Folders and Subfolders
   * in the same flat collection. parent_folder is
   * used to reconstruct the tree.
   */
  const folders =
    await client.getFolders(
      spaceId,
      {
        archived: includeArchived
      }
    );

  const folderTree =
    buildFolderTree(folders);

  statistics.top_level_folders =
    folderTree.roots.length;

  statistics.subfolders =
    folders.length -
    folderTree.roots.length;

  if (folderTree.orphans.length > 0) {
    statistics.warnings.push(
      `${folderTree.orphans.length} Folder or Subfolder objects had missing parents.`
    );
  }

  const seenListIds = new Set();
  const seenTaskIds = new Set();

  for (const rootFolder of folderTree.roots) {
    await archiveFolderRecursively({
      folder: rootFolder,

      outputParent: path.join(
        spaceTemporaryPath,
        "folders"
      ),

      client,

      context: {
        workspaceId,
        spaceId,
        includeArchived,
        includeClosed,
        includeSubtasks,
        seenListIds,
        seenTaskIds,
        statistics
      }
    });
  }

  /*
   * Preserve orphaned folders rather than silently
   * omitting them. This can happen if permissions hide
   * a parent Folder while exposing a descendant.
   */
  for (
    const orphanFolder of folderTree.orphans
  ) {
    statistics.warnings.push(
      [
        `Folder ${orphanFolder.id}`,
        `was archived under orphaned-folders because`,
        `its parent ${getParentFolderId(orphanFolder)}`,
        `was not returned by ClickUp.`
      ].join(" ")
    );

    await archiveFolderRecursively({
      folder: orphanFolder,

      outputParent: path.join(
        spaceTemporaryPath,
        "orphaned-folders"
      ),

      client,

      context: {
        workspaceId,
        spaceId,
        includeArchived,
        includeClosed,
        includeSubtasks,
        seenListIds,
        seenTaskIds,
        statistics
      }
    });
  }

  /*
   * Lists can live directly in the Space without a
   * Folder.
   */
  const folderlessLists =
    await client.getFolderlessLists(
      spaceId,
      {
        archived: includeArchived
      }
    );

  statistics.folderless_lists =
    folderlessLists.length;

  for (const list of sortById(folderlessLists)) {
    await archiveList({
      list,

      outputParent: path.join(
        spaceTemporaryPath,
        "folderless-lists"
      ),

      client,

      context: {
        workspaceId,
        spaceId,
        folderId: null,
        includeArchived,
        includeClosed,
        includeSubtasks,
        seenListIds,
        seenTaskIds,
        statistics
      }
    });
  }

  validateSnapshot({
    space,
    folders,
    seenListIds,
    seenTaskIds,
    statistics
  });

  const hierarchy = createHierarchy({
    workspace,
    space,
    folderRoots: folderTree.roots,
    orphanFolders: folderTree.orphans,
    folderlessLists
  });

  await writeJson(
    path.join(
      spaceTemporaryPath,
      "hierarchy.json"
    ),
    hierarchy
  );

  const manifestContent = {
    schema_version: "1.0",
    scope: "space",

    workspace: {
      id: workspaceId,
      name: workspace.name
    },

    space: {
      id: String(space.id),
      name: space.name
    },

    settings: {
      include_archived: includeArchived,
      include_closed: includeClosed,
      include_subtasks: includeSubtasks
    },

    counts: {
      top_level_folders:
        statistics.top_level_folders,

      subfolders:
        statistics.subfolders,

      folderless_lists:
        statistics.folderless_lists,

      lists:
        statistics.lists,

      tasks:
        statistics.tasks,

      subtasks:
        statistics.subtasks
    },

    warnings:
      [...statistics.warnings].sort()
  };

  const manifest = {
    ...manifestContent,

    content_sha256: sha256(
      manifestContent
    )
  };

  await writeJson(
    path.join(
      spaceTemporaryPath,
      "manifest.json"
    ),
    manifest
  );

  /*
   * The final archive path contains the Workspace and
   * only this Space. This lets multiple Space workflows
   * share the same Workspace tree.
   */
  const finalWorkspacePath =
    path.join(
      archiveRoot,
      workspaceId
    );

  const finalSpacePath =
    path.join(
      finalWorkspacePath,
      "spaces",
      spaceId
    );

  const backupPath =
    path.join(
      ".tmp",
      `backup-${workspaceId}-${spaceId}-${runId}`
    );

  await fs.mkdir(
    finalWorkspacePath,
    {
      recursive: true
    }
  );

  await writeJson(
    path.join(
      finalWorkspacePath,
      "workspace.json"
    ),
    normalizeWorkspace(workspace)
  );

  await replaceDirectoryAtomically({
    temporaryPath:
      spaceTemporaryPath,

    finalPath:
      finalSpacePath,

    backupPath
  });

  const completedAt = new Date();

  statistics.api_requests =
    client.statistics.requests;

  statistics.api_retries =
    client.statistics.retries;

  await writeJson(
    auditPath,
    {
      success: true,
      run_id: runId,

      trigger:
        process.env.ARCHIVE_TRIGGER ??
        "local",

      workspace_id: workspaceId,
      space_id: spaceId,

      started_at:
        startedAt.toISOString(),

      completed_at:
        completedAt.toISOString(),

      duration_seconds:
        Math.round(
          (
            completedAt.getTime() -
            startedAt.getTime()
          ) / 1000
        ),

      statistics
    }
  );

  await fs.rm(
    temporaryRoot,
    {
      recursive: true,
      force: true
    }
  );

  console.log(
    [
      `Archived ClickUp Space`,
      `${space.name} (${spaceId}).`
    ].join(" ")
  );

  console.log(
    [
      `Folders:`,
      statistics.top_level_folders,
      `top-level and`,
      statistics.subfolders,
      `nested.`
    ].join(" ")
  );

  console.log(
    [
      `Lists:`,
      statistics.lists,
      `including`,
      statistics.folderless_lists,
      `folderless.`
    ].join(" ")
  );

  console.log(
    [
      `Tasks:`,
      statistics.tasks,
      `plus`,
      statistics.subtasks,
      `Subtasks.`
    ].join(" ")
  );
} catch (error) {
  statistics.api_requests =
    client.statistics.requests;

  statistics.api_retries =
    client.statistics.retries;

  const failedAt = new Date();

  await writeJson(
    auditPath,
    {
      success: false,
      run_id: runId,

      trigger:
        process.env.ARCHIVE_TRIGGER ??
        "local",

      space_id: spaceId,

      started_at:
        startedAt.toISOString(),

      failed_at:
        failedAt.toISOString(),

      duration_seconds:
        Math.round(
          (
            failedAt.getTime() -
            startedAt.getTime()
          ) / 1000
        ),

      error: {
        name: error.name,
        message: error.message,
        status: error.status ?? null
      },

      statistics
    }
  );

  await fs.rm(
    temporaryRoot,
    {
      recursive: true,
      force: true
    }
  );

  console.error(error);
  process.exitCode = 1;
}

function buildFolderTree(folders) {
  const foldersById = new Map();

  for (const sourceFolder of folders) {
    const folder = {
      ...sourceFolder,
      children: []
    };

    foldersById.set(
      String(folder.id),
      folder
    );
  }

  const roots = [];
  const orphans = [];

  for (const folder of foldersById.values()) {
    const parentId =
      getParentFolderId(folder);

    if (!parentId) {
      roots.push(folder);
      continue;
    }

    const parent =
      foldersById.get(parentId);

    if (!parent) {
      orphans.push(folder);
      continue;
    }

    parent.children.push(folder);
  }

  for (const folder of foldersById.values()) {
    folder.children =
      sortById(folder.children);
  }

  return {
    roots: sortById(roots),
    orphans: sortById(orphans),
    foldersById
  };
}

async function archiveFolderRecursively({
  folder,
  outputParent,
  client,
  context
}) {
  const folderId =
    String(folder.id);

  const folderPath =
    path.join(
      outputParent,
      folderId
    );

  await fs.mkdir(
    folderPath,
    {
      recursive: true
    }
  );

  await writeJson(
    path.join(
      folderPath,
      "folder.json"
    ),
    normalizeFolder(
      folder,
      {
        workspaceId:
          context.workspaceId,

        spaceId:
          context.spaceId
      }
    )
  );

  const lists =
    await client.getFolderLists(
      folderId,
      {
        archived:
          context.includeArchived
      }
    );

  for (const list of sortById(lists)) {
    await archiveList({
      list,

      outputParent: path.join(
        folderPath,
        "lists"
      ),

      client,

      context: {
        ...context,
        folderId
      }
    });
  }

  for (
    const childFolder of sortById(
      folder.children ?? []
    )
  ) {
    await archiveFolderRecursively({
      folder: childFolder,

      outputParent: path.join(
        folderPath,
        "subfolders"
      ),

      client,
      context
    });
  }
}

async function archiveList({
  list,
  outputParent,
  client,
  context
}) {
  const listId =
    String(list.id);

  if (
    context.seenListIds.has(listId)
  ) {
    throw new Error(
      `Duplicate List ID discovered: ${listId}`
    );
  }

  context.seenListIds.add(listId);
  context.statistics.lists += 1;

  const listPath =
    path.join(
      outputParent,
      listId
    );

  const tasksPath =
    path.join(
      listPath,
      "tasks"
    );

  await fs.mkdir(
    tasksPath,
    {
      recursive: true
    }
  );

  const listDetails =
    await client.getList(listId);

  await writeJson(
    path.join(
      listPath,
      "list.json"
    ),
    normalizeList(
      listDetails,
      {
        workspaceId:
          context.workspaceId,

        spaceId:
          context.spaceId,

        folderId:
          context.folderId
      }
    )
  );

  const tasks =
    await client.getAllListTasks(
      listId,
      {
        archived:
          context.includeArchived,

        includeClosed:
          context.includeClosed,

        includeSubtasks:
          context.includeSubtasks
      }
    );

  const taskTree =
    buildTaskTree(tasks);

  for (const rootTask of taskTree.roots) {
    await archiveTaskRecursively({
      task: rootTask,
      outputParent: tasksPath,
      context: {
        ...context,
        listId
      }
    });
  }

  /*
   * A Subtask may be returned without its parent Task
   * because of permissions, filtering, or API behavior.
   * Preserve it under orphaned-subtasks.
   */
  for (
    const orphanTask of taskTree.orphans
  ) {
    context.statistics.warnings.push(
      [
        `Subtask ${orphanTask.id}`,
        `in List ${listId} was returned without`,
        `parent Task ${orphanTask.parent}.`
      ].join(" ")
    );

    await archiveTaskRecursively({
      task: orphanTask,

      outputParent: path.join(
        listPath,
        "orphaned-subtasks"
      ),

      context: {
        ...context,
        listId
      }
    });
  }
}

function buildTaskTree(tasks) {
  const tasksById = new Map();

  for (const sourceTask of tasks) {
    tasksById.set(
      String(sourceTask.id),
      {
        ...sourceTask,
        children: []
      }
    );
  }

  const roots = [];
  const orphans = [];

  for (const task of tasksById.values()) {
    const parentId =
      task.parent != null
        ? String(task.parent)
        : null;

    if (!parentId) {
      roots.push(task);
      continue;
    }

    const parent =
      tasksById.get(parentId);

    if (!parent) {
      orphans.push(task);
      continue;
    }

    parent.children.push(task);
  }

  for (const task of tasksById.values()) {
    task.children =
      sortById(task.children);
  }

  return {
    roots: sortById(roots),
    orphans: sortById(orphans)
  };
}

async function archiveTaskRecursively({
  task,
  outputParent,
  context
}) {
  const taskId =
    String(task.id);

  if (
    context.seenTaskIds.has(taskId)
  ) {
    throw new Error(
      `Duplicate Task or Subtask ID discovered: ${taskId}`
    );
  }

  context.seenTaskIds.add(taskId);

  const isSubtask =
    task.parent != null;

  if (isSubtask) {
    context.statistics.subtasks += 1;
  } else {
    context.statistics.tasks += 1;
  }

  const taskPath =
    path.join(
      outputParent,
      taskId
    );

  await fs.mkdir(
    taskPath,
    {
      recursive: true
    }
  );

  await writeJson(
    path.join(
      taskPath,
      "task.json"
    ),
    normalizeTask(
      task,
      {
        workspaceId:
          context.workspaceId,

        spaceId:
          context.spaceId,

        folderId:
          context.folderId,

        listId:
          context.listId
      }
    )
  );

  for (
    const childTask of sortById(
      task.children ?? []
    )
  ) {
    await archiveTaskRecursively({
      task: childTask,

      outputParent: path.join(
        taskPath,
        "subtasks"
      ),

      context
    });
  }
}

function validateSnapshot({
  space,
  folders,
  seenListIds,
  seenTaskIds,
  statistics
}) {
  if (
    String(space.id) !==
    String(spaceId)
  ) {
    throw new Error(
      [
        `Requested Space ${spaceId},`,
        `but ClickUp returned Space ${space.id}.`
      ].join(" ")
    );
  }

  const folderIds =
    folders.map(folder =>
      String(folder.id)
    );

  if (
    new Set(folderIds).size !==
    folderIds.length
  ) {
    throw new Error(
      "Duplicate Folder IDs were returned by ClickUp."
    );
  }

  if (
    statistics.lists !==
    seenListIds.size
  ) {
    throw new Error(
      "List validation count mismatch."
    );
  }

  if (
    statistics.tasks +
    statistics.subtasks !==
    seenTaskIds.size
  ) {
    throw new Error(
      "Task validation count mismatch."
    );
  }

  if (
    statistics.lists === 0
  ) {
    statistics.warnings.push(
      "The Space contained zero accessible Lists."
    );
  }
}

function createHierarchy({
  workspace,
  space,
  folderRoots,
  orphanFolders,
  folderlessLists
}) {
  return stableSortObject({
    schema_version: "1.0",

    workspace: {
      id: String(workspace.id),
      name: workspace.name
    },

    space: {
      id: String(space.id),
      name: space.name
    },

    folders:
      sortById(folderRoots)
        .map(folderHierarchyEntry),

    orphaned_folders:
      sortById(orphanFolders)
        .map(folderHierarchyEntry),

    folderless_lists:
      sortById(folderlessLists)
        .map(list => ({
          id: String(list.id),
          name: list.name ?? null
        }))
  });
}

function folderHierarchyEntry(folder) {
  return {
    id: String(folder.id),
    name: folder.name ?? null,

    parent_folder_id:
      getParentFolderId(folder),

    subfolders:
      sortById(
        folder.children ?? []
      ).map(folderHierarchyEntry)
  };
}

function sortById(items = []) {
  return [...items].sort((a, b) =>
    String(a.id).localeCompare(
      String(b.id)
    )
  );
}