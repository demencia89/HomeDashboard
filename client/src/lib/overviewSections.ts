import { defaultOverviewSectionOrder } from '../constants';
import type { OverviewSectionId, OverviewSectionPreferences } from '../types';

export function normalizeOverviewSectionPreferencesByServer(value: unknown): Record<string, OverviewSectionPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  if ('order' in value || 'hidden' in value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([serverId]) => serverId.trim())
      .map(([serverId, preferences]) => [serverId, normalizeOverviewSectionPreferences(preferences)]),
  );
}

export function normalizeOverviewSectionPreferences(value: unknown): OverviewSectionPreferences {
  const source = value && typeof value === 'object' ? value as Partial<OverviewSectionPreferences> : {};
  const order = Array.isArray(source.order)
    ? source.order.filter(isOverviewSectionId)
    : [];
  const hidden = Array.isArray(source.hidden)
    ? source.hidden.filter(isOverviewSectionId)
    : [];

  return {
    order: uniqueSectionIds([...order, ...defaultOverviewSectionOrder]),
    hidden: uniqueSectionIds(hidden),
  };
}

export function updateServerSectionPreferences(
  current: Record<string, OverviewSectionPreferences>,
  serverId: string,
  update: (preferences: OverviewSectionPreferences) => OverviewSectionPreferences,
): Record<string, OverviewSectionPreferences> {
  return {
    ...current,
    [serverId]: normalizeOverviewSectionPreferences(update(normalizeOverviewSectionPreferences(current[serverId]))),
  };
}

export function moveSectionId(order: OverviewSectionId[], sectionId: OverviewSectionId, direction: -1 | 1): OverviewSectionId[] {
  const normalized = normalizeOverviewSectionPreferences({ order, hidden: [] }).order;
  const currentIndex = normalized.indexOf(sectionId);
  const nextIndex = currentIndex + direction;

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= normalized.length) {
    return normalized;
  }

  const next = [...normalized];
  const [moved] = next.splice(currentIndex, 1);
  next.splice(nextIndex, 0, moved);
  return next;
}

function uniqueSectionIds(sectionIds: OverviewSectionId[]): OverviewSectionId[] {
  return sectionIds.filter((sectionId, index) => sectionIds.indexOf(sectionId) === index);
}

function isOverviewSectionId(value: unknown): value is OverviewSectionId {
  return value === 'filesystems' || value === 'processes';
}
