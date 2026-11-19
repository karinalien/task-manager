const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, createConfirmed } = require("./helpers");
const { TaskStore } = require("../lib/store");

test("work marks persist independently of columns and clear irrelevant comments", async (t) => {
    const f = await fixture(t);
    let task = await createConfirmed(f.service, { requestId: randomUUID(), projectId: f.project.id, title: "Метки исполнения" });
    for (const workStatus of ["accepted", "clarification", "impossible", "fix", "completed", "none"]) {
        task = await f.service.update(task.id, { expectedRevision: task.editRevision || 0, workStatus, workStatusComment: "  Причина и следующий шаг  " });
        assert.equal(task.workStatus, workStatus);
        assert.equal(task.workStatusComment, ["clarification", "impossible", "fix"].includes(workStatus) ? "Причина и следующий шаг" : "");
        for (const column of ["progress", "review", "done", "todo"]) {
            task = await f.service.move(task.id, column);
            assert.equal(task.workStatus, workStatus);
        }
    }
    task = await f.service.update(task.id, { expectedRevision: task.editRevision, workStatus: "fix", workStatusComment: "<img src=x onerror=alert(1)>" });
    assert.equal(f.github.creates, 1);
    await f.store.close();
    const reopened = await new TaskStore(f.dir).open();
    t.after(() => reopened.close());
    assert.equal(reopened.list()[0].workStatus, "fix");
    assert.equal(reopened.list()[0].workStatusComment, "<img src=x onerror=alert(1)>");
});

test("invalid marks and missing reasons cannot modify a task; revisions prevent lost updates", async (t) => {
    const f = await fixture(t);
    let task = await createConfirmed(f.service, { requestId: randomUUID(), projectId: f.project.id, title: "Причины" });
    for (const patch of [{ workStatus: "review" }, { workStatus: "__proto__" }, { workStatus: "fix" }, { workStatus: "clarification", workStatusComment: " " }, { workStatus: "impossible", workStatusComment: "x".repeat(1001) }, { workStatus: "fix", workStatusComment: null }]) {
        await assert.rejects(f.service.update(task.id, { expectedRevision: 0, ...patch }), { status: 400 });
        assert.deepEqual(f.service.find(task.id), task);
    }
    task = await f.service.update(task.id, { expectedRevision: 0, workStatus: "clarification", workStatusComment: "Что делать?" });
    await assert.rejects(f.service.update(task.id, { expectedRevision: 1, workStatus: "impossible" }), { code: "task_work_comment" });
    await assert.rejects(f.service.update(task.id, { expectedRevision: 0, workStatus: "completed" }), { code: "task_changed" });
    const updated = await f.service.update(task.id, { expectedRevision: 1, title: "Другое название" });
    assert.equal(updated.workStatusComment, "Что делать?");
    const draft = await f.service.create({ requestId: randomUUID(), projectId: f.project.id, title: "Черновик", useAi: false });
    await assert.rejects(f.service.update(draft.id, { expectedRevision: 0, workStatus: "accepted" }), { code: "task_unconfirmed" });
});
