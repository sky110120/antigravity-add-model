import { createHash } from 'node:crypto';

export interface CatalogIdentity {
  name: string;
  externalModelName?: string;
  displayName?: string;
}
export const slugPart = (value: string) =>
  value
    .replace(/^models\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
export function legacyModelSlug(model: CatalogIdentity): string {
  return 'custom-' + slugPart(model.externalModelName || model.name);
}
/** An always-available routing alias tied to the saved model, including its effort settings. */
export function localModelSlug(model: CatalogIdentity): string {
  return `custom-${slugPart(model.name)}-${createHash('sha256').update(model.name).digest('hex').slice(0, 12)}`;
}
export function catalogModelSlug(model: CatalogIdentity, models: CatalogIdentity[]): string {
  const legacy = legacyModelSlug(model);
  return models.filter((item) => legacyModelSlug(item) === legacy).length === 1 &&
    !models.some((item) => item.name !== model.name && localModelSlug(item) === legacy)
    ? legacy
    : localModelSlug(model);
}
export function matchesModelSlug(model: CatalogIdentity, value: string, models: CatalogIdentity[]): boolean {
  const id = value.replace(/^models\//, '');
  return id === localModelSlug(model) || id === catalogModelSlug(model, models);
}

/** The native IDE resolves sorted options by label, so display labels must also be unique. */
export function catalogDisplayNames(models: CatalogIdentity[], upstream: unknown = {}): Map<string, string> {
  const used = new Set<string>();
  if (upstream && typeof upstream === 'object') {
    for (const key of ['models', 'availableModels', 'available_models']) {
      const collection = (upstream as Record<string, unknown>)[key];
      if (!collection || typeof collection !== 'object') continue;
      for (const entry of Object.values(collection)) {
        if (typeof entry?.displayName === 'string') used.add(entry.displayName);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const model of models) {
    const label = model.displayName || model.name;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const model of [...models].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const base = model.displayName || model.name;
    let label = base;
    if (counts.get(base)! > 1 || used.has(label)) label = `${base} (${model.name.replace(/^models\//, '')})`;
    let suffix = 2;
    while (used.has(label)) label = `${base} (${model.name.replace(/^models\//, '')} #${suffix++})`;
    used.add(label);
    labels.set(model.name, label);
  }
  return labels;
}

export interface CatalogEntry {
  slug: string;
  mapEntry: Record<string, unknown>;
  listEntry: Record<string, unknown>;
  model?: CatalogIdentity & {
    reasoningEffort?: string;
    copyFrom?: string;
  };
}

/** Preserve native metadata while advertising only configured custom models in every response shape. */
export function mergeCloudCodeCatalog(upstream: unknown, entries: CatalogEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> =
    upstream && typeof upstream === 'object' && !Array.isArray(upstream)
      ? { ...(upstream as Record<string, unknown>) }
      : {};

  // Detect and group reasoning effort variants (e.g. low, medium, high)
  const groupCandidates = new Map<
    string,
    {
      baseDisplayName: string;
      baseSlug: string;
      variants: { effort: string; effortDisplayName: string; variantSlug: string; entry: CatalogEntry }[];
    }
  >();
  const entryGroupMap = new Map<CatalogEntry, { baseSlug: string; variantSlug: string }>();

  for (const entry of entries) {
    const disp =
      (typeof entry.mapEntry?.displayName === 'string' ? entry.mapEntry.displayName : '') ||
      (typeof entry.listEntry?.displayName === 'string' ? entry.listEntry.displayName : '') ||
      entry.model?.displayName ||
      '';
    const effortMatch =
      disp.match(/^(.*?)\s*\((low|medium|high|xhigh|minimal|none)\)$/i) ||
      (entry.model?.name || '').match(/^(.*?)-(low|medium|high|xhigh)$/i);
    const effort = (entry.model?.reasoningEffort || (effortMatch ? effortMatch[2] : '')).toLowerCase();
    const baseName = effortMatch ? effortMatch[1].trim() : entry.model?.externalModelName || '';

    if (effort && baseName) {
      const baseSlug = 'custom-' + slugPart(baseName);
      const variantSlug = `${baseSlug}-${effort}`;
      const effortDisplayName =
        effort === 'xhigh'
          ? 'XHigh'
          : effort === 'minimal'
            ? 'Minimal'
            : effort === 'max'
              ? 'Max'
              : effort.charAt(0).toUpperCase() + effort.slice(1);
      if (!groupCandidates.has(baseSlug)) {
        groupCandidates.set(baseSlug, { baseDisplayName: baseName, baseSlug, variants: [] });
      }
      groupCandidates.get(baseSlug)!.variants.push({ effort, effortDisplayName, variantSlug, entry });
    }
  }

  // Only form a group if there are at least 2 variants
  const activeGroups = new Map<
    string,
    {
      baseDisplayName: string;
      baseSlug: string;
      variants: { effort: string; effortDisplayName: string; variantSlug: string; entry: CatalogEntry }[];
    }
  >();
  for (const [baseSlug, group] of groupCandidates) {
    if (group.variants.length >= 2) {
      activeGroups.set(baseSlug, group);
      for (const v of group.variants) {
        entryGroupMap.set(v.entry, { baseSlug, variantSlug: v.variantSlug });
      }
    }
  }

  // Build extra grouped_models and top-level IDs
  const customGroupedModels: Record<string, unknown> = {};
  const extraEntries: CatalogEntry[] = [];
  const topLevelIds: string[] = [];

  for (const [baseSlug, group] of activeGroups) {
    // Sort variants: high/xhigh first so that the default option picked by the UI is high
    const effortOrder = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
    const sortedVariants = [...group.variants].sort((a, b) => {
      const ia = effortOrder.indexOf(a.effort);
      const ib = effortOrder.indexOf(b.effort);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    // In grouped_models / groupedModels, supportedThinkingLevels is ordered low -> high
    const thinkingLevelsOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const sortedThinkingLevels = [...group.variants].sort((a, b) => {
      const ia = thinkingLevelsOrder.indexOf(a.effort);
      const ib = thinkingLevelsOrder.indexOf(b.effort);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    customGroupedModels[baseSlug] = {
      displayName: group.baseDisplayName,
      // protojson maps snake_case and camelCase spellings below to ONE field;
      // emitting both makes the language server fail with a duplicate field
      // parse error on supported_thinking_levels. Keep camelCase only.
      supportedThinkingLevels: sortedThinkingLevels.map((v) => ({
        thinkingSuffix: v.effort,
        thinkingDisplayName: v.effortDisplayName,
      })),
    };

    // The variants MUST be in topLevelIds (agentModelSorts.modelIds) so that language_server
    // registers them in clientModelConfigs with modelId `${baseSlug}-${effort}`.
    // The frontend's w7c will automatically deduplicate them into a single row using groupedModels.
    for (const v of sortedVariants) {
      topLevelIds.push(v.variantSlug);
    }

    // Pick default variant (prefer high -> medium -> low -> first)
    const defaultVariant =
      group.variants.find((v) => v.effort === 'high') ||
      group.variants.find((v) => v.effort === 'medium') ||
      group.variants[0];

    // Base model entry
    extraEntries.push({
      slug: baseSlug,
      model: defaultVariant.entry.model,
      mapEntry: { ...defaultVariant.entry.mapEntry, displayName: group.baseDisplayName },
      listEntry: { ...defaultVariant.entry.listEntry, name: 'models/' + baseSlug, displayName: group.baseDisplayName },
    });

    // Variant entries under baseSlug-effort
    for (const v of group.variants) {
      extraEntries.push({
        slug: v.variantSlug,
        model: v.entry.model,
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
    } else if (value && typeof value === 'object') {
      result[key] = {
        ...(value as Record<string, unknown>),
        ...Object.fromEntries(allEntries.map((entry) => [entry.slug, { ...entry.mapEntry }])),
      };
      merged = true;
    }
  }
  if (!merged) result.models = Object.fromEntries(allEntries.map((entry) => [entry.slug, { ...entry.mapEntry }]));

  if (Object.keys(customGroupedModels).length > 0) {
    const upstreamGrouped = (
      result.grouped_models && typeof result.grouped_models === 'object' && !Array.isArray(result.grouped_models)
        ? result.grouped_models
        : result.groupedModels && typeof result.groupedModels === 'object' && !Array.isArray(result.groupedModels)
          ? result.groupedModels
          : {}
    ) as Record<string, unknown>;
    // grouped_models and groupedModels are one proto field; leaving both
    // spellings behind is another duplicate-field parse error. Collapse to
    // the canonical camelCase json name.
    delete result.grouped_models;
    delete result.groupedModels;
    result.groupedModels = { ...upstreamGrouped, ...customGroupedModels };
  }

  if (!entries.length) return result;

  const ids = [...new Set(topLevelIds)];
  // Same proto field under two spellings (agentModelSorts/agent_model_sorts):
  // keep whichever array spelling is already present, never both. Read before
  // deleting: the key must survive under exactly one spelling.
  const sorts = Array.isArray(result.agentModelSorts)
    ? result.agentModelSorts
    : Array.isArray(result.agent_model_sorts)
      ? result.agent_model_sorts
      : [];
  const sortsKey: string = Array.isArray(result.agentModelSorts)
    ? 'agentModelSorts'
    : Array.isArray(result.agent_model_sorts)
      ? 'agent_model_sorts'
      : 'agentModelSorts';
  delete result.agentModelSorts;
  delete result.agent_model_sorts;
  let attached = false;
  result[sortsKey] = sorts.map((sort) => {
    if (!sort || typeof sort !== 'object' || !Array.isArray(sort.groups)) return sort;
    return {
      ...sort,
      groups: sort.groups.map((group: unknown) => {
        if (!group || typeof group !== 'object') return group;
        const original = group as Record<string, unknown>;
        if (!Array.isArray(original.modelIds)) return group;
        attached = true;
        return { ...original, modelIds: [...new Set([...original.modelIds, ...ids])] };
      }),
    };
  });
  if (!attached) (result[sortsKey] as unknown[]).push({ displayName: 'Custom models', groups: [{ modelIds: ids }] });
  return result;
}
