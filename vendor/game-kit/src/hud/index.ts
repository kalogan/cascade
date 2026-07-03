/**
 * HUD shell — a framework-agnostic, vanilla-DOM overlay of stacked layers.
 *
 * THREE-FREE: this module never imports three (it's pure DOM + a pure core).
 *
 * A HUD owns an ordered registry of LAYERS, each an absolutely-positioned div
 * appended to the container. `update(state)` fans the state out to every layer's
 * optional `onUpdate`. The registry + visibility + fanout logic is factored into a
 * PURE `LayerRegistry` operating on a minimal element interface, so add/get/remove
 * + update-fanout are unit-testable WITHOUT a real DOM (pass tiny stub elements).
 * The DOM `createHud` is a thin wrapper that supplies real elements.
 */

/** The slice of an HTMLElement the pure registry needs — stubbable in tests. */
export interface HudElement {
  style: { display: string };
  className: string;
}

export interface HudLayer {
  /** Stable id used for getLayer/removeLayer. */
  id: string;
  /** The layer's element (a real HTMLElement under createHud). */
  el: HudElement;
  /** Show/hide the layer (toggles `el.style.display`). */
  setVisible(v: boolean): void;
  /** Optional per-frame/per-tick update hook, called by HUD.update(state). */
  onUpdate?(state: unknown): void;
}

export interface AddLayerOptions {
  /** Class applied to the layer element (in addition to the base layer class). */
  className?: string;
}

/**
 * PURE core: an ordered registry of layers over a minimal element interface.
 * Knows nothing about the DOM — the caller supplies a factory that builds an
 * `HudElement` (real div, or a stub in tests) and an optional mount/unmount hook.
 */
export class LayerRegistry {
  private readonly layers = new Map<string, HudLayer>();

  constructor(
    /** Build the element for a new layer (real `document.createElement('div')` or a stub). */
    private readonly createElement: () => HudElement,
    /** Attach an element to the container (no-op in tests). */
    private readonly mount: (el: HudElement) => void = () => {},
    /** Detach an element from the container (no-op in tests). */
    private readonly unmount: (el: HudElement) => void = () => {},
  ) {}

  /** Add a layer. Throws if `id` already exists (ids must be unique). */
  add(id: string, opts: AddLayerOptions = {}): HudLayer {
    if (this.layers.has(id)) {
      throw new Error(`LayerRegistry.add: layer "${id}" already exists`);
    }
    const el = this.createElement();
    if (opts.className) el.className = opts.className;
    const layer: HudLayer = {
      id,
      el,
      setVisible(v: boolean): void {
        el.style.display = v ? '' : 'none';
      },
    };
    this.layers.set(id, layer);
    this.mount(el);
    return layer;
  }

  get(id: string): HudLayer | undefined {
    return this.layers.get(id);
  }

  /** Remove a layer (unmounting its element). No-op if `id` is unknown. */
  remove(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.layers.delete(id);
    this.unmount(layer.el);
  }

  /** Fan a state object out to every layer's `onUpdate` (insertion order). */
  update(state: unknown): void {
    for (const layer of this.layers.values()) {
      layer.onUpdate?.(state);
    }
  }

  /** Remove every layer (used by destroy). */
  clear(): void {
    for (const id of [...this.layers.keys()]) this.remove(id);
  }

  /** Current layer count (test/introspection helper). */
  get size(): number {
    return this.layers.size;
  }
}

export interface Hud {
  /** Add an absolutely-positioned layer. Throws if `id` already exists. */
  addLayer(id: string, opts?: AddLayerOptions): HudLayer;
  getLayer(id: string): HudLayer | undefined;
  removeLayer(id: string): void;
  /** Fan `state` out to every layer's onUpdate. */
  update(state: unknown): void;
  /** Remove all layers and detach from the container. */
  destroy(): void;
}

/** Base class applied to every layer element (consumers style `.game-kit-hud-layer`). */
const LAYER_BASE_CLASS = 'game-kit-hud-layer';

/**
 * Create a DOM HUD inside `container`. Layers are absolutely-positioned divs
 * appended to the container; the container is given `position: relative` if it is
 * currently statically positioned so absolute layers anchor to it.
 */
export function createHud(container: HTMLElement): Hud {
  // Anchor absolute children to the container unless it's already positioned.
  if (container.style.position === '' || container.style.position === 'static') {
    container.style.position = 'relative';
  }

  const registry = new LayerRegistry(
    () => {
      const div = document.createElement('div');
      div.className = LAYER_BASE_CLASS;
      div.style.position = 'absolute';
      div.style.inset = '0';
      return div as unknown as HudElement;
    },
    (el) => {
      container.appendChild(el as unknown as HTMLElement);
    },
    (el) => {
      const node = el as unknown as HTMLElement;
      node.parentNode?.removeChild(node);
    },
  );

  return {
    addLayer(id: string, opts: AddLayerOptions = {}): HudLayer {
      // Compose the base class with any caller class so the base styling survives.
      const className = opts.className ? `${LAYER_BASE_CLASS} ${opts.className}` : undefined;
      return registry.add(id, className ? { className } : {});
    },
    getLayer(id: string): HudLayer | undefined {
      return registry.get(id);
    },
    removeLayer(id: string): void {
      registry.remove(id);
    },
    update(state: unknown): void {
      registry.update(state);
    },
    destroy(): void {
      registry.clear();
    },
  };
}
