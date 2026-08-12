export interface VirtualListWindowOptions {
  itemCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}

export interface VirtualListWindow {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

export function virtualListWindow(options: VirtualListWindowOptions): VirtualListWindow {
  const itemCount = Math.max(0, Math.floor(options.itemCount));
  if (itemCount === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
  }
  if (!(options.rowHeight > 0)) {
    throw new Error("Virtual list row height must be positive.");
  }
  const viewportHeight = Math.max(options.rowHeight, options.viewportHeight);
  const maximumScrollTop = Math.max(0, itemCount * options.rowHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, options.scrollTop), maximumScrollTop);
  const overscan = Math.max(0, Math.floor(options.overscan));
  const visibleStart = Math.floor(scrollTop / options.rowHeight);
  const visibleEnd = Math.ceil((scrollTop + viewportHeight) / options.rowHeight);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(itemCount, visibleEnd + overscan);
  return {
    start,
    end,
    topSpacer: start * options.rowHeight,
    bottomSpacer: (itemCount - end) * options.rowHeight,
  };
}

export function nearestItemScrollTop(
  itemIndex: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const itemTop = Math.max(0, itemIndex) * rowHeight;
  const itemBottom = itemTop + rowHeight;
  if (itemTop < scrollTop) {
    return itemTop;
  }
  if (itemBottom > scrollTop + viewportHeight) {
    return Math.max(0, itemBottom - viewportHeight);
  }
  return scrollTop;
}
