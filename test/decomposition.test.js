const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../server");
const { createLlm } = require("../lib/llm");
const { validateDecomposition } = require("../lib/decomposition");
const { fixture } = require("./helpers");

test("decomposition is an authenticated project preview that neither persists tasks nor calls GitHub", async (t) => {
    const f = await fixture(t);
    const { project } = f;
    const planned = { tasks: [
        { title: "Подготовить CSV", description: "Выгрузить задачи проекта", estimatedHours: 1.5, requiredGroups: ["backend"] },
        { title: "Проверить CSV", description: "Проверить пустой результат", estimatedHours: null, requiredGroups: ["testing"] }
    ] };
    let output = planned;
    let respond = () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
    let calls = 0;
    const prompt = "Добавить CSV-экспорт задач проекта. Не добавлять импорт.";
    let expectedPrompt = prompt;
    const generate = createLlm(f.config.llm, { fetchFn: async (_, request) => {
        calls++;
        const body = JSON.parse(request.body);
        assert.equal(body.response_format.json_schema.name, "task_decomposition");
        assert.equal(JSON.parse(body.messages.at(-1).content).task, expectedPrompt);
        return respond();
    } });
    f.config.auth = { username: "team", password: "test-password", secret: "s".repeat(32) };
    f.github.listRepositories = async () => assert.fail("Preview called GitHub");
    const app = await createApp({ config: f.config, store: f.store, github: f.github, generate });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    t.after(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const post = (route, body, headers = {}) => fetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const input = { projectId: project.id, prompt };
    assert.equal((await post("/api/ai/decompose", input)).status, 401);
    const login = await post("/api/auth/login", { username: "team", password: "test-password" });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.get("set-cookie").split(";")[0] };
    const preview = (body, headers = auth) => post("/api/ai/decompose", body, headers);
    assert.equal((await preview(input, { ...auth, Origin: "https://other.example" })).status, 403);
    assert.equal((await preview({ ...input, projectId: "other" })).status, 404);
    assert.equal((await preview({ ...input, prompt: " " })).status, 400);
    assert.equal(calls, 0);
    const response = await preview(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), planned);

    const scope = "Добавить CSV-экспорт только для задач текущего проекта.";
    expectedPrompt = scope;
    const scoped = await preview({ ...input, prompt: scope });
    assert.equal(scoped.status, 200);
    assert.deepEqual(await scoped.json(), { tasks: [
        { ...planned.tasks[0], description: planned.tasks[0].description + "\n\n" + scope },
        planned.tasks[1]
    ] });
    expectedPrompt = prompt;
    const invalidRows = [
        { title: "  подготовить   CSV! " },
        { title: "..." },
        { description: " " },
        { description: "Выгрузить задачи проекта." },
        { estimatedHours: 1.25 },
        { estimatedHours: 0 },
        { estimatedHours: 10000.5 },
        { estimatedHours: "2" },
        { requiredGroups: ["invented"] },
        { requiredGroups: ["testing", "testing"] },
        { branch: "main" }
    ];
    const invalidResults = [null, {}, { tasks: [] }, { tasks: [planned.tasks[0]] },
        ...invalidRows.map((edits) => ({ tasks: [planned.tasks[0], { ...planned.tasks[1], ...edits }] }))];
    for (const invalidOutput of invalidResults) {
        output = invalidOutput;
        const invalid = await preview(input);
        assert.equal(invalid.status, 502);
        assert.equal((await invalid.json()).error.code, "decomposition_contract");
    }
    respond = () => Response.json({ choices: [{ message: { content: "незаконченный JSON {" } }] });
    const invalidJson = await preview(input);
    assert.equal(invalidJson.status, 502);
    assert.equal((await invalidJson.json()).error.code, "llm_json");

    respond = () => { throw new DOMException("expired", "TimeoutError"); };
    const timedOut = await preview(input);
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error.code, "llm_timeout");

    respond = () => Response.json({ choices: [{ message: { content: JSON.stringify(planned) } }] });
    const retried = await preview(input);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), planned);
    assert.equal(calls, invalidResults.length + 5);
    assert.deepEqual(f.store.list(), []);
    assert.equal(f.github.creates, 0);
});

test("project scope goes to the matching task and does not replace the model description", () => {
    const scope = "Выгружать только задачи выбранного проекта.";
    const tasks = [
        { title: "Проверить фильтр", description: "Написать тесты", estimatedHours: null, requiredGroups: [] },
        { title: "Выгружать задачи", description: "Подготовить CSV", estimatedHours: 2, requiredGroups: ["backend"] }
    ];
    const scoped = validateDecomposition({ tasks }, scope);
    assert.equal(scoped.tasks[0].description, tasks[0].description);
    assert.equal(scoped.tasks[1].description, "Подготовить CSV\n\n" + scope);
    assert.deepEqual(validateDecomposition(scoped, scope), scoped);
    assert.throws(() => validateDecomposition({ tasks: [
        tasks[0],
        { ...tasks[1], description: "а".repeat(1500) }
    ] }, scope), { code: "decomposition_scope" });
});
