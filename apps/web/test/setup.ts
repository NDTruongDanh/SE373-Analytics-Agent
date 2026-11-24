import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext(
    contextId: string,
  ) {
    if (contextId !== "2d") return null;
    return {
      font: "",
      letterSpacing: "",
      fillStyle: "#000000",
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
