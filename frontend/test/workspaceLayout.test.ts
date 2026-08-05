import { describe, it, expect } from 'vitest';
import { updatePanelConfig } from '../src/data/workspaceWidgets';
import type { WorkspaceLayout } from '../src/types/workspace';

// updatePanelConfig is what a workspace room panel's header switcher now writes
// through when the user picks a different room. Before the fix that switcher
// called the Feed's setPaneRoom instead, so the panel never moved.

const layout: WorkspaceLayout = {
  version: 2,
  columns: [
    { id: 'col-main', panels: [{ id: 'p1', type: 'room', config: { roomId: 'alpha' } }] },
    {
      id: 'col-stack',
      panels: [
        { id: 'p2', type: 'room', config: { roomId: 'beta' } },
        { id: 'p3', type: 'contracts' },
      ],
    },
  ],
};

describe('updatePanelConfig', () => {
  it('re-points only the targeted panel, leaving sibling room panels alone', () => {
    const next = updatePanelConfig(layout, 'p1', { roomId: 'mentions' });

    expect(next.columns[0].panels[0].config?.roomId).toBe('mentions');
    expect(next.columns[1].panels[0].config?.roomId).toBe('beta');
  });

  it('reaches panels in any column, not just the first', () => {
    const next = updatePanelConfig(layout, 'p2', { roomId: 'dm:123' });

    expect(next.columns[1].panels[0].config?.roomId).toBe('dm:123');
    expect(next.columns[0].panels[0].config?.roomId).toBe('alpha');
  });

  it('keeps the layout shape so the persisted config stays valid', () => {
    const next = updatePanelConfig(layout, 'p1', { roomId: 'mentions' });

    expect(next.version).toBe(2);
    expect(next.columns.map((c) => c.id)).toEqual(['col-main', 'col-stack']);
    expect(next.columns[1].panels.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(next.columns[1].panels[1].type).toBe('contracts');
  });

  it('does not mutate the layout it was given', () => {
    updatePanelConfig(layout, 'p1', { roomId: 'mentions' });

    expect(layout.columns[0].panels[0].config?.roomId).toBe('alpha');
  });

  it('is a no-op for an unknown panel id', () => {
    const next = updatePanelConfig(layout, 'nope', { roomId: 'mentions' });

    expect(next.columns[0].panels[0].config?.roomId).toBe('alpha');
    expect(next.columns[1].panels[0].config?.roomId).toBe('beta');
  });
});
