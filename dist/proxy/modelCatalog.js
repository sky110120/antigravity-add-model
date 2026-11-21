"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugPart = void 0;
exports.legacyModelSlug = legacyModelSlug;
exports.localModelSlug = localModelSlug;
exports.catalogModelSlug = catalogModelSlug;
exports.matchesModelSlug = matchesModelSlug;
exports.catalogDisplayNames = catalogDisplayNames;
exports.mergeCloudCodeCatalog = mergeCloudCodeCatalog;
const node_crypto_1 = require("node:crypto");
const slugPart = (value) => value
    .replace(/^models\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
exports.slugPart = slugPart;
function legacyModelSlug(model) {
    return 'custom-' + (0, exports.slugPart)(model.externalModelName || model.name);
}
/** An always-available routing alias tied to the saved model, including its effort settings. */
function localModelSlug(model) {
    return `custom-${(0, exports.slugPart)(model.name)}-${(0, node_crypto_1.createHash)('sha256').update(model.name).digest('hex').slice(0, 12)}`;
}
function catalogModelSlug(model, models) {
    const legacy = legacyModelSlug(model);
    return models.filter((item) => legacyModelSlug(item) === legacy).length === 1 &&
        !models.some((item) => item.name !== model.name && localModelSlug(item) === legacy)
        ? legacy
        : localModelSlug(model);
}
function matchesModelSlug(model, value, models) {
    const id = value.replace(/^models\//, '');
    return id === localModelSlug(model) || id === catalogModelSlug(model, models);
}
/** The native IDE resolves sorted options by label, so display labels must also be unique. */
function catalogDisplayNames(models, upstream = {}) {
    const used = new Set();
    if (upstream && typeof upstream === 'object') {
        for (const key of ['models', 'availableModels', 'available_models']) {
            const collection = upstream[key];
            if (!collection || typeof collection !== 'object')
                continue;
            for (const entry of Object.values(collection)) {
                if (typeof entry?.displayName === 'string')
                    used.add(entry.displayName);
            }
        }
    }
    const counts = new Map();
    for (const model of models) {
        const label = model.displayName || model.name;
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    const labels = new Map();
    for (const model of [...models].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const base = model.displayName || model.name;
        let label = base;
        if (counts.get(base) > 1 || used.has(label))
            label = `${base} (${model.name.replace(/^models\//, '')})`;
        let suffix = 2;
        while (used.has(label))
            label = `${base} (${model.name.replace(/^models\//, '')} #${suffix++})`;
        used.add(label);
        labels.set(model.name, label);
    }
    return labels;
}
/** Preserve native metadata while advertising only configured custom models in every response shape. */
function mergeCloudCodeCatalog(upstream, entries) {
    const result = upstream && typeof upstream === 'object' && !Array.isArray(upstream)
        ? { ...upstream }
        : {};
    // Detect and group reasoning effort variants (e.g. low, medium, high)
    const groupCandidates = new Map();
    const entryGroupMap = new Map();
    for (const entry of entries) {
        const disp = (typeof entry.mapEntry?.displayName === 'string' ? entry.mapEntry.displayName : '') ||
            (typeof entry.listEntry?.displayName === 'string' ? entry.listEntry.displayName : '') ||
            entry.model?.displayName ||
            '';
        const effortMatch = disp.match(/^(.*?)\s*\((low|medium|high|xhigh|minimal|none)\)$/i) ||
            (entry.model?.name || '').match(/^(.*?)-(low|medium|high|xhigh)$/i);
        const effort = (entry.model?.reasoningEffort || (effortMatch ? effortMatch[2] : '')).toLowerCase();
        const baseName = effortMatch ? effortMatch[1].trim() : entry.model?.externalModelName || '';
        if (effort && baseName) {
            const baseSlug = 'custom-' + (0, exports.slugPart)(baseName);
            const variantSlug = `${baseSlug}-${effort}`;
            const effortDisplayName = effort === 'xhigh'
                ? 'XHigh'
                : effort === 'minimal'
                    ? 'Minimal'
                    : effort === 'max'
                        ? 'Max'
                        : effort.charAt(0).toUpperCase() + effort.slice(1);
            if (!groupCandidates.has(baseSlug)) {
                groupCandidates.set(baseSlug, { baseDisplayName: baseName, baseSlug, variants: [] });
            }
            groupCandidates.get(baseSlug).variants.push({ effort, effortDisplayName, variantSlug, entry });
        }
    }
    // Only form a group if there are at least 2 variants
    const activeGroups = new Map();
    for (const [baseSlug, group] of groupCandidates) {
        if (group.variants.length >= 2) {
            activeGroups.set(baseSlug, group);
            for (const v of group.variants) {
                entryGroupMap.set(v.entry, { baseSlug, variantSlug: v.variantSlug });
            }
        }
    }
    // Build extra grouped_models and top-level IDs
    const customGroupedModels = {};
    const extraEntries = [];
    const topLevelIds = [];
    for (const [baseSlug, group] of activeGroups) {
        customGroupedModels[baseSlug] = {
            displayName: group.baseDisplayName,
            supportedThinkingLevels: group.variants.map((v) => ({
                thinkingSuffix: v.effort,
                thinkingDisplayName: v.effortDisplayName,
            })),
            supported_thinking_levels: group.variants.map((v) => ({
                thinking_suffix: v.effort,
                thinking_display_name: v.effortDisplayName,
            })),
        };
        topLevelIds.push(baseSlug);
        // Pick default variant (prefer high -> medium -> low -> first)
        const defaultVariant = group.variants.find((v) => v.effort === 'high') ||
            group.variants.find((v) => v.effort === 'medium') ||
            group.variants[0];
        // Base model entry
        extraEntries.push({
            slug: baseSlug,
            mapEntry: { ...defaultVariant.entry.mapEntry, displayName: group.baseDisplayName },
            listEntry: { ...defaultVariant.entry.listEntry, name: 'models/' + baseSlug, displayName: group.baseDisplayName },
        });
        // Variant entries under baseSlug-effort
        for (const v of group.variants) {
            extraEntries.push({
                slug: v.variantSlug,
                mapEntry: { ...v.entry.mapEntry, displayName: `${group.baseDisplayName} (${v.effort})` },
                listEntry: {
                    ...v.entry.listEntry,
                    name: 'models/' + v.variantSlug,
                    displayName: `${group.baseDisplayName} (${v.effort})`,
                },
            });
        }
    }
    for (const entry of entries) {
        if (!entryGroupMap.has(entry)) {
            topLevelIds.push(entry.slug);
        }
    }
    const allEntries = [...entries, ...extraEntries];
    let merged = false;
    for (const key of ['models', 'availableModels', 'available_models']) {
        const value = result[key];
        if (Array.isArray(value)) {
            const customNames = new Set(allEntries.map((entry) => entry.listEntry.name));
            result[key] = [
                ...allEntries.map((entry) => ({ ...entry.listEntry })),
                ...value.filter((item) => !customNames.has(item?.name)),
            ];
            merged = true;
        }
        else if (value && typeof value === 'object') {
            result[key] = {
                ...value,
                ...Object.fromEntries(allEntries.map((entry) => [entry.slug, { ...entry.mapEntry }])),
            };
            merged = true;
        }
    }
    if (!merged)
        result.models = Object.fromEntries(allEntries.map((entry) => [entry.slug, { ...entry.mapEntry }]));
    if (Object.keys(customGroupedModels).length > 0) {
        const upstreamGrouped = (result.grouped_models && typeof result.grouped_models === 'object' && !Array.isArray(result.grouped_models)
            ? result.grouped_models
            : result.groupedModels && typeof result.groupedModels === 'object' && !Array.isArray(result.groupedModels)
                ? result.groupedModels
                : {});
        result.grouped_models = { ...upstreamGrouped, ...customGroupedModels };
        result.groupedModels = { ...upstreamGrouped, ...customGroupedModels };
    }
    if (!entries.length)
        return result;
    const ids = [...new Set(topLevelIds)];
    const sorts = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
    let attached = false;
    result.agentModelSorts = sorts.map((sort) => {
        if (!sort || typeof sort !== 'object' || !Array.isArray(sort.groups))
            return sort;
        return {
            ...sort,
            groups: sort.groups.map((group) => {
                if (!group || typeof group !== 'object')
                    return group;
                const original = group;
                if (!Array.isArray(original.modelIds))
                    return group;
                attached = true;
                return { ...original, modelIds: [...new Set([...original.modelIds, ...ids])] };
            }),
        };
    });
    if (!attached)
        result.agentModelSorts.push({ displayName: 'Custom models', groups: [{ modelIds: ids }] });
    return result;
}
//# sourceMappingURL=modelCatalog.js.map