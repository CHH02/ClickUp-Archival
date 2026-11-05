const API_BASE_URL = "https://api.clickup.com/api/v2";

export class ClickUpClient {
  constructor({
    token,
    maxRetries = 4,
    requestDelayMs = 125
  }) {
    if (!token) {
      throw new Error(
        "A ClickUp API token is required."
      );
    }

    this.token = token;
    this.maxRetries = maxRetries;
    this.requestDelayMs = requestDelayMs;

    this.statistics = {
      requests: 0,
      retries: 0
    };
  }

  async request(path, query = {}) {
    const url = new URL(`${API_BASE_URL}${path}`);

    for (const [key, value] of Object.entries(query)) {
      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError;

    for (
      let attempt = 0;
      attempt <= this.maxRetries;
      attempt += 1
    ) {
      if (this.requestDelayMs > 0) {
        await sleep(this.requestDelayMs);
      }

      this.statistics.requests += 1;

      let response;

      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.token,
            Accept: "application/json",
            "Content-Type": "application/json"
          }
        });
      } catch (error) {
        lastError = error;

        if (attempt >= this.maxRetries) {
          break;
        }

        this.statistics.retries += 1;
        await sleep(backoffMilliseconds(attempt));
        continue;
      }

      if (response.ok) {
        return response.json();
      }

      const responseText = await response.text();

      const error = new Error(
        [
          `ClickUp API request failed.`,
          `HTTP ${response.status}`,
          `${url.pathname}${url.search}`,
          responseText.slice(0, 1000)
        ].join(" ")
      );

      error.status = response.status;
      error.responseText = responseText;
      lastError = error;

      if (!isRetryableStatus(response.status)) {
        throw error;
      }

      if (attempt >= this.maxRetries) {
        break;
      }

      this.statistics.retries += 1;

      const retryAfter =
        Number(response.headers.get("retry-after")) || 0;

      const delay =
        retryAfter > 0
          ? retryAfter * 1000
          : backoffMilliseconds(attempt);

      console.warn(
        `Retrying ClickUp request after HTTP ${response.status}.`
      );

      await sleep(delay);
    }

    throw lastError;
  }

  async getAuthorizedWorkspaces() {
    const response = await this.request("/team");
    return response.teams ?? [];
  }

  async getSpaces(
    workspaceId,
    { archived = false } = {}
  ) {
    const response = await this.request(
      `/team/${encodeURIComponent(workspaceId)}/space`,
      {
        archived
      }
    );

    return response.spaces ?? [];
  }

  async getSpace(spaceId) {
    return this.request(
      `/space/${encodeURIComponent(spaceId)}`
    );
  }

  async getFolders(
    spaceId,
    { archived = false } = {}
  ) {
    const response = await this.request(
      `/space/${encodeURIComponent(spaceId)}/folder`,
      {
        archived
      }
    );

    return response.folders ?? [];
  }

  async getFolderLists(
    folderId,
    { archived = false } = {}
  ) {
    const response = await this.request(
      `/folder/${encodeURIComponent(folderId)}/list`,
      {
        archived
      }
    );

    return response.lists ?? [];
  }

  async getFolderlessLists(
    spaceId,
    { archived = false } = {}
  ) {
    const response = await this.request(
      `/space/${encodeURIComponent(spaceId)}/list`,
      {
        archived
      }
    );

    return response.lists ?? [];
  }

  async getList(listId) {
    return this.request(
      `/list/${encodeURIComponent(listId)}`
    );
  }

  async getAllListTasks(
    listId,
    {
      archived = false,
      includeClosed = true,
      includeSubtasks = true
    } = {}
  ) {
    const allTasks = [];
    const seenTaskIds = new Set();

    let page = 0;

    while (true) {
      const response = await this.request(
        `/list/${encodeURIComponent(listId)}/task`,
        {
          archived,
          include_closed: includeClosed,
          subtasks: includeSubtasks,
          page
        }
      );

      const tasks = response.tasks ?? [];

      if (tasks.length === 0) {
        break;
      }

      let newTasksOnPage = 0;

      for (const task of tasks) {
        const taskId = String(task.id);

        if (!seenTaskIds.has(taskId)) {
          seenTaskIds.add(taskId);
          allTasks.push(task);
          newTasksOnPage += 1;
        }
      }

      /*
       * ClickUp pages normally contain up to 100 tasks.
       * A short page indicates that the final page was reached.
       */
      if (tasks.length < 100) {
        break;
      }

      /*
       * Prevent an infinite loop if the API returns the same
       * page repeatedly.
       */
      if (newTasksOnPage === 0) {
        throw new Error(
          `Task pagination repeated data for List ${listId} on page ${page}.`
        );
      }

      page += 1;

      if (page > 10000) {
        throw new Error(
          `Task pagination exceeded the safety limit for List ${listId}.`
        );
      }
    }

    return allTasks;
  }
}

function isRetryableStatus(status) {
  return [
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

function backoffMilliseconds(attempt) {
  const base = Math.min(
    1000 * 2 ** attempt,
    16000
  );

  const jitter = Math.floor(
    Math.random() * 250
  );

  return base + jitter;
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}