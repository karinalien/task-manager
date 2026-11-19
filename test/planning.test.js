const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { planningInput, workloads, assignmentPreview, validateRecommended } = require("../lib/planning");
const { fixture, createConfirmed, specification } = require("./helpers");
const { createApp } = require("../server");
const { TaskStore } = require("../lib/store");

const people = [
    { id: "a", name: "Alice", executor_type: "human", groups: ["backend", "data"], stack: ["Python"], capacity: 8 },
    { id: "b", name: "Bob", executor_type: "human", groups: ["backend", "data"], stack: ["Node.js", "SQLite"], capacity: 8 },
    { id: "c", name: "Carol", executor_type: "human", groups: ["design"], stack: ["Node.js"], capacity: 8 },
    { id: "ai", name: "Agent", executor_type: "ai_agent", groups: ["backend", "data"], stack: ["Node.js"], capacity: 100 }
];
const task = (id, patch = {}) => ({ id, assigneeId: "a", confirmedAt: "2026-11-18", projectId: "p", column: "todo", estimatedHours: 3, ...patch });

test("workload counts all projects, excludes done and drafts, and never conceals unknown hours", () => {
    const tasks = [task("one"), task("two", { projectId: "other", estimatedHours: 2 }), task("done", { column: "done", estimatedHours: 20 }), task("draft", { confirmedAt: null, estimatedHours: 20 }), task("unknown", { estimatedHours: undefined })];
    const load = workloads(people, tasks)[0];
    assert.equal(load.assignedTasks, 3);
    assert.equal(load.assignedHours, 5);
    assert.equal(load.availableHours, 3);
    assert.equal(load.unknownTasks, 1);
    assert.equal(workloads(people, tasks, "one")[0].assignedHours, 2);
    assert.equal(assignmentPreview(task("new", { assigneeId: null }), { requiredGroups: ["backend"] }, people, tasks).candidates.find((item) => item.employeeId === "a").eligible, false);
    assert.equal(workloads(people, [task("big", { estimatedHours: 10 })])[0].overloadHours, 2);
});

test("groups are mandatory, technology is a preference, AI is excluded and ties are deterministic", () => {
    const planned = task("new", { assigneeId: null, requiredGroups: ["backend", "data"], requiredTechnologies: ["Node.js", "SQLite"] });
    const before = JSON.stringify([planned, people]);
    const result = assignmentPreview(planned, {}, people, []);
    assert.equal(result.recommendedId, "b");
    assert.equal(result.candidates.find((item) => item.employeeId === "a").eligible, true);
    assert.equal(result.candidates.find((item) => item.employeeId === "c").eligible, false);
    assert.equal(result.candidates.find((item) => item.employeeId === "ai").eligible, false);
    assert.equal(assignmentPreview(planned, { requiredTechnologies: [] }, people, []).recommendedId, "a");
    assert.equal(assignmentPreview(planned, { estimatedHours: null }, people, []).recommendedId, null);
    assert.equal(assignmentPreview(planned, { requiredGroups: [] }, people, []).recommendedId, null);
    assert.equal(assignmentPreview({ ...planned, column: "done" }, {}, people, []).recommendedId, null);
    assert.equal(JSON.stringify([planned, people]), before);
});

test("reassignment excludes the old estimate of the task itself, not the new estimate", () => {
    const current = task("self", { estimatedHours: 8, requiredGroups: ["backend"] });
    const result = assignmentPreview(current, { estimatedHours: 6 }, people, [current, task("other", { estimatedHours: 2 })]);
    assert.equal(result.candidates.find((item) => item.employeeId === "a").eligible, true);
    assert.equal(result.candidates.find((item) => item.employeeId === "a").projectedHours, 8);
    assert.equal(assignmentPreview(current, { estimatedHours: 6.5 }, people, [current, task("other", { estimatedHours: 2 })]).candidates.find((item) => item.employeeId === "a").eligible, false);
});

test("planning validation rejects invalid hours and unknown catalog entries", () => {
    for (const estimatedHours of [0, -1, 0.3, 10000.5, "3", Infinity]) assert.throws(() => planningInput({ estimatedHours }), { code: "task_hours" });
    for (const fields of [{ requiredGroups: ["no"] }, { requiredGroups: "backend" }, { requiredTechnologies: ["made-up"] }]) assert.throws(() => planningInput(fields), { code: "task_competencies" });
    assert.deepEqual(planningInput({ estimatedHours: null, requiredGroups: ["backend", "backend"] }), { estimatedHours: null, requiredGroups: ["backend"] });
});

test("concurrent recommended assignments recheck capacity; manual override remains possible; fields persist", async (t) => {
    const f = await fixture(t);
    const first = await createConfirmed(f.service, { requestId: randomUUID(), projectId: f.project.id, title: "Первая задача" });
    const second = await createConfirmed(f.service, { requestId: randomUUID(), projectId: f.project.id, title: "Вторая задача" });
    const employee = [{ ...people[0], capacity: 4 }];
    const patch = { expectedRevision: 0, assigneeId: "a", estimatedHours: 3, requiredGroups: ["backend"], requiredTechnologies: ["Node.js"], assignmentMode: "recommended" };
    const validateAssignment = (task) => validateRecommended(task, employee, f.store.list());
    const results = await Promise.allSettled([f.service.update(first.id, patch, { validateAssignment }), f.service.update(second.id, patch, { validateAssignment })]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.find((item) => item.status === "rejected").reason.code, "assignment_changed");
    const rejected = f.service.find(second.id).assigneeId ? first : second;
    await f.service.update(rejected.id, { ...patch, assignmentMode: undefined }).then(() => assert.fail("undefined mode should be rejected"), (error) => assert.equal(error.code, "assignment_mode"));
    const { assignmentMode, ...manual } = patch;
    await f.service.update(rejected.id, manual);
    assert.equal(workloads(employee, f.store.list())[0].overloadHours, 2);
    assert.equal(f.github.creates, 2);
    await f.store.close();
    const reopened = await new TaskStore(f.dir).open();
    t.after(() => reopened.close());
    assert.equal(reopened.list().find((item) => item.id === rejected.id).estimatedHours, 3);
    assert.deepEqual(reopened.list().find((item) => item.id === rejected.id).requiredGroups, ["backend"]);
    assert.equal(Object.hasOwn(reopened.list()[0], "assignmentMode"), false);
});

async function start(t, auth = {}) {
    const f = await fixture(t);
    const app = await createApp({ config: { ...f.config, auth }, github: f.github, store: f.store, generate: async () => specification });
    t.after(() => app.close());
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { "Content-Type": "application/json", Origin: origin };
    const post = (url, body, method = "POST") => fetch(origin + url, { method, headers, body: JSON.stringify(body) });
    return { ...f, ...app, origin, headers, post };
}

test("HTTP preview is read-only, scoped to project and revision, and saving revalidates stale recommendations", async (t) => {
    const f = await start(t);
    await f.post("/api/employees/sofia", { groups: ["backend"], capacity: 4, stack: ["Node.js"] }, "PATCH");
    const created = await createConfirmed(f.tasks, { requestId: randomUUID(), projectId: f.project.id, title: "API задачи" });
    const body = { projectId: f.project.id, expectedRevision: 0, estimatedHours: 3, requiredGroups: ["backend"], requiredTechnologies: ["Node.js"] };
    const before = JSON.stringify(f.store.list());
    const response = await f.post(`/api/tasks/${created.id}/assignment-preview`, body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recommendedId, "sofia");
    assert.equal(JSON.stringify(f.store.list()), before);
    assert.equal((await f.post(`/api/tasks/${created.id}/assignment-preview`, { ...body, projectId: "other" })).status, 400);
    assert.equal((await f.post(`/api/tasks/${created.id}/assignment-preview`, { ...body, expectedRevision: 10 })).status, 409);
    await f.post("/api/employees/sofia", { capacity: 2 }, "PATCH");
    const { projectId, ...patch } = body;
    assert.equal((await f.post(`/api/tasks/${created.id}`, { ...patch, assigneeId: "sofia", assignmentMode: "recommended" }, "PATCH")).status, 409);
    assert.equal(f.tasks.find(created.id).assigneeId, null);
    await f.post("/api/employees/sofia", { capacity: 4 }, "PATCH");
    assert.equal((await f.post(`/api/tasks/${created.id}`, { ...patch, assigneeId: "sofia", assignmentMode: "recommended" }, "PATCH")).status, 200);
    let loads = (await (await fetch(f.origin + "/api/workloads")).json()).workloads;
    assert.equal(loads.find((load) => load.employeeId === "sofia").assignedHours, 3);
    await f.tasks.move(created.id, "done");
    loads = (await (await fetch(f.origin + "/api/workloads")).json()).workloads;
    assert.equal(loads.find((load) => load.employeeId === "sofia").assignedHours, 0);
    assert.equal(f.github.creates, 1);
});

test("planning endpoints require login and reject foreign Origin", async (t) => {
    const f = await start(t, { username: "team", password: "synthetic", secret: "x".repeat(40) });
    assert.equal((await fetch(f.origin + "/api/workloads")).status, 401);
    assert.equal((await f.post(`/api/tasks/${randomUUID()}/assignment-preview`, {})).status, 401);
    const response = await fetch(f.origin + "/api/auth/login", { method: "POST", headers: f.headers, body: JSON.stringify({ username: "team", password: "synthetic" }) });
    const Cookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(f.origin + `/api/tasks/${randomUUID()}/assignment-preview`, { method: "POST", headers: { ...f.headers, Origin: "https://foreign.test", Cookie }, body: "{}" })).status, 403);
    assert.equal((await fetch(f.origin + "/api/workloads", { headers: { Cookie } })).status, 200);
});
