/**
 * The shared vocabulary for editor tools.
 *
 * Every editing surface in the workbench — sprite pixels, voxel cells, map
 * tiles, handheld skins — offers its own set of tools, and the sets genuinely
 * differ: "Add a cube" means nothing in 2D, "Ellipse" means nothing in a voxel
 * grid. What does not differ is what a tool *needs from the rail*. A pencil and
 * a voxel brush both want an adjustable size; a paint bucket and a voxel flood
 * both want a colour tolerance. Before this module each editor answered those
 * questions with its own hand-maintained list of tool ids, which is how the same
 * "which tools are weighted?" set came to exist in four places.
 *
 * So a tool declares its capabilities alongside its label and glyph, and the
 * rail asks the tool rather than consulting a list kept somewhere else. Adding a
 * tool is then one entry in one table, and it cannot be half-registered.
 *
 * Deliberately excluded: anything true of only one medium. The voxel editor's
 * "which tools can apply a material" stays in `voxelTools`, because a shared
 * vocabulary that grows a term per medium stops being shared.
 */

/**
 * The optional rail controls a tool drives, independent of what it paints.
 *
 * Each flag answers one question the rail asks while rendering, and each is
 * genuinely cross-medium — every flag here is used by at least two editors.
 */
export interface ToolCapabilities {
  /** Stroke thickness is adjustable, so the rail offers a brush-size slider. */
  readonly weighted: boolean;
  /** Spread across near-matching colours is adjustable, so the rail offers a tolerance slider. */
  readonly tolerant: boolean;
  /** The stroke is dragged out and previewed live, committing on release. */
  readonly dragged: boolean;
}

/** A tool as the rail needs to render it, plus what it asks the rail to show. */
export interface ToolDefinition<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly glyph: string;
  /** Tooltip text. Omitted when the label already says enough. */
  readonly hint?: string;
  /**
   * Single key that selects this tool, lower-case. Declared beside the tool so
   * a binding, its tooltip and its row in the shortcut overlay all come from
   * one place — a key documented in three files is a key that stops matching
   * what the editor actually does.
   */
  readonly key?: string;
  /**
   * The controls this tool drives. Anything left out is off, so a plain tool
   * needs no entry at all and the tables stay readable.
   */
  readonly capabilities?: Partial<ToolCapabilities>;
}

/** A tool that drives no optional controls — also the answer for an unknown id. */
const NO_CAPABILITIES: ToolCapabilities = { weighted: false, tolerant: false, dragged: false };

/**
 * Resolve a tool's capabilities to a complete record.
 *
 * An unknown id yields {@link NO_CAPABILITIES} rather than throwing: the id
 * comes from editor state that can outlive a tool being renamed or removed, and
 * a rail that renders one fewer slider is a better failure than a rail that
 * refuses to mount.
 */
export function capabilitiesOf<Id extends string>(
  tools: readonly ToolDefinition<Id>[],
  id: Id,
): ToolCapabilities {
  const definition = tools.find((tool) => tool.id === id);
  return definition ? { ...NO_CAPABILITIES, ...definition.capabilities } : NO_CAPABILITIES;
}

/**
 * The ids of every tool with a given capability.
 *
 * For the canvases that branch on a set rather than on the active tool — they
 * ask "is this one of the dragged tools?" per pointer event, and a set keeps
 * that a lookup instead of a scan.
 */
export function toolIdsWith<Id extends string>(
  tools: readonly ToolDefinition<Id>[],
  capability: keyof ToolCapabilities,
): ReadonlySet<Id> {
  return new Set(tools.filter((tool) => tool.capabilities?.[capability] === true).map((tool) => tool.id));
}
