function setupTaskDecomposition({ byId, api, element, currentProject, taskInput, groups }) {
    const dialog = byId("decompositionDialog");
    const source = byId("decompositionSource");
    const generate = byId("generateDecomposition");
    const add = byId("appendSubtask");
    const editor = byId("decompositionEditor");
    const list = byId("decompositionList");
    const status = byId("decompositionStatus");
    const drafts = new Map();
    const groupIds = groups.map(({ id }) => id);
    const { limits, validate } = DecompositionDraft;
    let shownProjectId;

    const draftKey = (projectId) => `task-manager.decomposition.v1:${projectId}`;
    function persist(draft) {
        try {
            sessionStorage.setItem(draftKey(draft.projectId), JSON.stringify({ source: draft.source, tasks: draft.tasks }));
        } catch { /* Черновик остаётся доступен до закрытия страницы. */ }
    }

    function restore(projectId) {
        try {
            const draft = JSON.parse(sessionStorage.getItem(draftKey(projectId)));
            if (typeof draft?.source === "string" && Array.isArray(draft.tasks) && draft.tasks.length <= limits.maxDraftTasks &&
                draft.tasks.every((task) => typeof task?.title === "string" && typeof task.description === "string" &&
                    (task.estimatedHours === null || Number.isFinite(task.estimatedHours)) &&
                    Array.isArray(task.requiredGroups) && task.requiredGroups.every((id) => groupIds.includes(id)))) return draft;
        } catch { /* Необязательное сохранение в этой вкладке. */ }
        return { source: taskInput.value, tasks: [] };
    }

    const shown = () => drafts.get(shownProjectId);
    const refreshActions = (draft) => {
        generate.disabled = draft.pending || draft.source.trim().length < 5;
        generate.textContent = draft.pending ? "Готовим подзадачи…" : draft.tasks.length ? "Заменить список с ИИ" : "Разбить с ИИ";
        source.disabled = draft.pending;
        editor.disabled = draft.pending;
        add.disabled = draft.pending || draft.tasks.length >= limits.maxDraftTasks;
        byId("decompositionNote").hidden = draft.tasks.length === 0;
    };

    function row(task, draft) {
        const details = element("details", "subtask-editor");
        const summary = element("summary");
        const updateSummary = () => {
            const name = task.title.trim() || "Новая подзадача";
            summary.textContent = task.estimatedHours == null ? name : `${name} · ${task.estimatedHours} ч`;
        };
        details.appendChild(summary);
        for (const [field, label, tag, maxLength] of [["title", "Название", "input", limits.title], ["description", "Описание", "textarea", limits.description]]) {
            const wrapper = element("label", "draft-field", label);
            const input = element(tag);
            input.maxLength = maxLength;
            input.value = task[field];
            input.addEventListener("input", () => { task[field] = input.value; updateSummary(); persist(draft); });
            wrapper.appendChild(input);
            details.appendChild(wrapper);
        }
        const estimate = element("label", "draft-field subtask-hours", "Плановая оценка, ч");
        const hours = element("input");
        hours.type = "number";
        hours.min = String(limits.minHours);
        hours.max = String(limits.maxHours);
        hours.step = String(limits.hoursStep);
        hours.value = task.estimatedHours ?? "";
        hours.addEventListener("input", () => {
            task.estimatedHours = hours.value === "" ? null : Number(hours.value);
            updateSummary();
            persist(draft);
        });
        estimate.appendChild(hours);
        details.appendChild(estimate);
        const choices = element("fieldset", "subtask-groups");
        choices.appendChild(element("legend", "", "Компетенции"));
        for (const { id, name } of groups) {
            const label = element("label");
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = task.requiredGroups.includes(id);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked && !task.requiredGroups.includes(id)) task.requiredGroups.push(id);
                else if (!checkbox.checked) task.requiredGroups = task.requiredGroups.filter((value) => value !== id);
                persist(draft);
            });
            label.appendChild(checkbox);
            label.appendChild(element("span", "", name));
            choices.appendChild(label);
        }
        details.appendChild(choices);
        const remove = element("button", "btn light", "Удалить из черновика");
        remove.type = "button";
        remove.addEventListener("click", () => {
            draft.tasks = draft.tasks.filter((item) => item !== task);
            persist(draft);
            details.remove();
            refreshActions(draft);
            add.focus();
        });
        details.appendChild(remove);
        updateSummary();
        return details;
    }

    function render(draft) {
        source.value = draft.source;
        status.textContent = draft.message;
        list.replaceChildren(...draft.tasks.map((task) => row(task, draft)));
        refreshActions(draft);
    }

    byId("openDecomposition").addEventListener("click", () => {
        const project = currentProject();
        if (!project || project.archived || dialog.open) return;
        shownProjectId = project.id;
        if (!drafts.has(project.id)) {
            const draft = { ...restore(project.id), projectId: project.id, pending: false, message: "" };
            drafts.set(project.id, draft);
            persist(draft);
        }
        render(shown());
        dialog.showModal();
    });
    byId("closeDecomposition").addEventListener("click", () => dialog.close());
    source.addEventListener("input", () => {
        const draft = shown();
        draft.source = source.value;
        persist(draft);
        refreshActions(draft);
    });
    add.addEventListener("click", () => {
        const draft = shown();
        if (draft.pending || draft.tasks.length >= limits.maxDraftTasks) return;
        const task = { title: "", description: "", estimatedHours: null, requiredGroups: [] };
        draft.tasks.push(task);
        persist(draft);
        const details = row(task, draft);
        details.open = true;
        list.appendChild(details);
        details.querySelector("input").focus();
        refreshActions(draft);
    });
    generate.addEventListener("click", async () => {
        const projectId = shownProjectId;
        const project = currentProject();
        const draft = shown();
        if (!draft || draft.pending || !project || project.id !== projectId || project.archived || draft.source.trim().length < 5) return;
        draft.pending = true;
        draft.message = "Подготовка может занять несколько минут.";
        status.textContent = draft.message;
        refreshActions(draft);
        let updated = false;
        try {
            const result = await api("/api/ai/decompose", { method: "POST", body: JSON.stringify({ projectId, prompt: draft.source.trim() }) });
            draft.tasks = validate(result, groupIds).tasks;
            persist(draft);
            draft.message = "Подзадачи готовы. Откройте строку, чтобы её изменить.";
            updated = true;
        } catch (error) {
            draft.message = error.message;
        } finally {
            draft.pending = false;
            if (shownProjectId === projectId) {
                if (updated) render(draft);
                else {
                    status.textContent = draft.message;
                    refreshActions(draft);
                }
            }
        }
    });
}
