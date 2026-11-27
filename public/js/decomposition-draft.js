(function (root) {
    const limits = {
        minTasks: 2, maxTasks: 5, maxDraftTasks: 8,
        title: 300, description: 1500,
        minHours: 0.5, maxHours: 10000, hoursStep: 0.5
    };
    const fields = ["title", "description", "estimatedHours", "requiredGroups"];
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const normalized = (text) => text.normalize("NFKC").toLocaleLowerCase("ru").replace(/[\p{P}\s]+/gu, " ").trim();

    function validate(result, groupIds) {
        const fail = (problem) => { throw new Error(`ИИ вернул ${problem}. Попробуйте ещё раз.`); };
        if (!isObject(result) || Object.keys(result).length !== 1 || !Array.isArray(result.tasks) ||
            result.tasks.length < limits.minTasks || result.tasks.length > limits.maxTasks) {
            fail("неполный или неверный список подзадач");
        }
        const titles = new Set();
        const descriptions = new Set();
        const tasks = result.tasks.map((task) => {
            if (!isObject(task) || Object.keys(task).length !== fields.length ||
                !fields.every((field) => Object.hasOwn(task, field)) ||
                typeof task.title !== "string" || task.title.length > limits.title ||
                typeof task.description !== "string" || task.description.length > limits.description) {
                fail("подзадачу с неверными полями");
            }
            const { estimatedHours, requiredGroups } = task;
            const title = normalized(task.title);
            const description = normalized(task.description);
            if (!title || !description) fail("подзадачу без названия или описания");
            if (titles.has(title) || descriptions.has(description)) fail("повторяющиеся подзадачи");
            if (estimatedHours !== null && (!Number.isFinite(estimatedHours) || estimatedHours < limits.minHours ||
                estimatedHours > limits.maxHours || !Number.isInteger(estimatedHours / limits.hoursStep))) {
                fail("подзадачу с некорректной оценкой часов");
            }
            if (!Array.isArray(requiredGroups) || requiredGroups.length > groupIds.length ||
                requiredGroups.some((id) => !groupIds.includes(id)) || new Set(requiredGroups).size !== requiredGroups.length) {
                fail("подзадачу с неизвестными или повторяющимися компетенциями");
            }
            titles.add(title);
            descriptions.add(description);
            return { title: task.title.trim(), description: task.description.trim(), estimatedHours, requiredGroups: [...requiredGroups] };
        });
        return { tasks };
    }

    const decompositionDraft = { fields, limits, validate };
    if (typeof module !== "undefined" && module.exports) module.exports = decompositionDraft;
    else root.DecompositionDraft = decompositionDraft;
})(typeof globalThis === "undefined" ? this : globalThis);
