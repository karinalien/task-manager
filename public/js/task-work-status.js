/* Метка исполнителя независима от колонки канбана и технического состояния GitHub/ИИ. */
(function (root) {
    const statuses = {
        none: { label: "Не выбрана", comment: false },
        accepted: { label: "Принято", comment: false },
        clarification: { label: "На уточнении", comment: true },
        impossible: { label: "Приостановлено", comment: true },
        fix: { label: "Исправить", comment: true },
        completed: { label: "Выполнено", comment: false }
    };
    if (typeof module !== "undefined" && module.exports) module.exports = statuses;
    else root.TaskWorkStatuses = statuses;
})(typeof globalThis === "undefined" ? this : globalThis);
