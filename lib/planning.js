const { AppError } = require("./errors");
const options = require("../public/js/employee-options");
const technologies = new Set(options.technologies.flatMap(([, items]) => items));
const groupIds = new Set(options.groups.map((group) => group.id));

function planningInput(input) {
    const result = {};
    if (Object.hasOwn(input, "estimatedHours")) {
        const hours = input.estimatedHours;
        if (hours !== null && (!Number.isFinite(hours) || hours < 0.5 || hours > 10000 || !Number.isInteger(hours * 2))) {
            throw new AppError(400, "task_hours", "Укажите оценку от 0,5 до 10000 часов с шагом 0,5 или оставьте её пустой.");
        }
        result.estimatedHours = hours;
    }
    for (const [field, allowed, maximum] of [["requiredGroups", groupIds, groupIds.size], ["requiredTechnologies", technologies, 50]]) {
        if (!Object.hasOwn(input, field)) continue;
        const values = input[field];
        if (!Array.isArray(values) || values.length > maximum || values.some((value) => typeof value !== "string" || !allowed.has(value))) {
            throw new AppError(400, "task_competencies", "Выберите компетенции и технологии из справочника.");
        }
        result[field] = [...new Set(values)];
    }
    return result;
}

function knownHours(task) {
    return Number.isFinite(task.estimatedHours) && task.estimatedHours > 0 ? task.estimatedHours : null;
}

function workloads(employees, tasks, excludeId = null) {
    return employees.map((employee) => {
        const assigned = tasks.filter((task) => task.id !== excludeId && task.assigneeId === employee.id && (task.branch || task.confirmedAt) && (task.column || task.status) !== "done");
        const assignedHours = assigned.reduce((total, task) => total + (knownHours(task) || 0), 0);
        const unknownTasks = assigned.filter((task) => knownHours(task) === null).length;
        return { employeeId: employee.id, assignedTasks: assigned.length, assignedHours, unknownTasks, capacity: employee.capacity, availableHours: Math.max(0, employee.capacity - assignedHours), overloadHours: Math.max(0, assignedHours - employee.capacity) };
    });
}

function assignmentPreview(task, input, employees, tasks) {
    const fields = { ...task, ...planningInput(input) };
    const requiredGroups = fields.requiredGroups || [];
    const requiredTechnologies = fields.requiredTechnologies || [];
    const hours = knownHours(fields);
    const ready = hours !== null && requiredGroups.length > 0 && (task.column || task.status) !== "done";
    const load = workloads(employees, tasks, task.id);
    const candidates = employees.map((employee, index) => {
        const workload = load[index];
        const missingGroups = requiredGroups.filter((id) => !(employee.groups || []).includes(id));
        const matchingTechnologies = requiredTechnologies.filter((name) => (employee.stack || []).includes(name));
        const reasons = [];
        if (!ready) reasons.push("Укажите оценку и группы для незавершённой задачи.");
        if (employee.executor_type !== "human") reasons.push("Выполнение задач ИИ-агентом ещё не подключено.");
        if (missingGroups.length) reasons.push("Не все требуемые компетенции указаны в профиле.");
        if (workload.unknownTasks) reasons.push("У назначенных задач есть неизвестные оценки.");
        if (hours !== null && workload.assignedHours + hours > workload.capacity) reasons.push("Недостаточно свободных часов.");
        return { ...workload, name: employee.name, missingGroups, matchingTechnologies, projectedHours: workload.assignedHours + (hours || 0), eligible: reasons.length === 0, reasons };
    });
    candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.matchingTechnologies.length - a.matchingTechnologies.length || b.availableHours - a.availableHours || a.employeeId.localeCompare(b.employeeId));
    return { ready, estimatedHours: hours, requiredGroups, requiredTechnologies, candidates, recommendedId: candidates.find((candidate) => candidate.eligible)?.employeeId || null };
}

function validateRecommended(task, employees, tasks) {
    const preview = assignmentPreview(task, {}, employees, tasks);
    const candidate = preview.candidates.find((item) => item.employeeId === task.assigneeId);
    if (!candidate?.eligible) throw new AppError(409, "assignment_changed", "Рекомендация устарела или исполнитель не подходит. Обновите подбор; введённые данные сохранены в форме.");
}

module.exports = { planningInput, workloads, assignmentPreview, validateRecommended };
