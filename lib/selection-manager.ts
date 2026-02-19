/**
 * SelectionManager - Text selection for terminal (xterm.js pattern)
 *
 * Based on xterm.js SelectionService architecture.
 * Manages text selection across terminal viewport and scrollback buffer.
 *
 * Features:
 * - Single/Double/Triple click selection (NORMAL/WORD/LINE modes)
 * - Shift+click to extend selection
 * - Alt+drag for block/column selection
 * - Auto-scroll when dragging near edges
 * - Works with mouse tracking applications (Shift to force selection)
 * - Proper word boundary detection
 */

import type { IRenderer } from './interfaces';
import { SelectionModel } from './selection-model';

// ============================================================================
// Types
// ============================================================================

/**
 * Selection mode determines how selection expands during drag
 */
export enum SelectionMode {
  NORMAL,   // Character-by-character selection
  WORD,     // Word selection (double-click)
  LINE,     // Line selection (triple-click)
  COLUMN    // Block/rectangular selection (Alt+drag)
}

/**
 * Word position in a line
 */
interface IWordPosition {
  start: number;
  length: number;
}

/**
 * Configuration callbacks for SelectionManager
 */
export interface SelectionManagerConfig {
  /** Get current viewport Y position (0 = at bottom, >0 = scrolled into history) */
  getViewportY: () => number;
  /** Get scrollback buffer length */
  getScrollbackLength: () => number;
  /** Get terminal dimensions */
  getDimensions: () => { rows: number; cols: number };
  /** Get cell dimensions in CSS pixels */
  getCellDimensions: () => { width: number; height: number };
  /** Scroll the viewport by lines (positive = scroll down toward current, negative = scroll up into history) */
  scrollBy: (lines: number) => void;
  /** Get text from buffer at given absolute line index */
  getLineText: (lineIndex: number) => string;
  /** Check if mouse tracking is enabled (for terminal apps) */
  hasMouseTracking: () => boolean;
  /** Dynamic getter for requireShift setting */
  getRequireShift: () => boolean;
  /** Renderer for visual updates */
  renderer?: IRenderer & {
    setSelectionRange?: (startCol: number, startRow: number, endCol: number, endRow: number, mode: 'Linear' | 'Block') => void;
    clearSelection?: () => void;
    copyToClipboard?: (text: string) => void;
    /** Notify renderer about selection state (to prevent frame skipping) */
    setIsSelecting?: (value: boolean) => void;
  };
}

// ============================================================================
// Constants (from xterm.js)
// ============================================================================

/** Max pixels from edge for max scroll speed */
const DRAG_SCROLL_MAX_THRESHOLD = 50;

/** Max lines to scroll per drag scroll tick */
const DRAG_SCROLL_MAX_SPEED = 15;

/** Milliseconds between drag scroll updates */
const DRAG_SCROLL_INTERVAL = 50;

/** Characters that separate words */
const WORD_SEPARATORS = ' \t\n\r`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

// ============================================================================
// SelectionManager
// ============================================================================

export class SelectionManager {
  private _config: SelectionManagerConfig;
  private _model: SelectionModel;

  // Current selection mode
  private _activeSelectionMode: SelectionMode = SelectionMode.NORMAL;

  // Whether selection is enabled (false when terminal has mouse tracking)
  private _enabled: boolean = true;

  // Drag scroll state
  private _dragScrollAmount: number = 0;
  private _dragScrollIntervalTimer: number | undefined;

  // Animation frame for selection refresh
  private _refreshAnimationFrame: number | undefined;

  // Track if we're currently selecting (mouse down and dragging)
  private _isSelecting: boolean = false;

  // Container element for viewport calculations
  private _containerElement: HTMLElement | null = null;

  // Document listeners (for mouse events outside container)
  private _mouseMoveListener: (e: MouseEvent) => void;
  private _mouseUpListener: (e: MouseEvent) => void;

  // Track last mouse Y for auto-scroll
  private _lastMouseEvent: MouseEvent | null = null;

  // Pending selection start (for drag-to-select in apps with mouse tracking)
  // When mouse tracking is active and requireShift=false, we wait for drag before starting selection
  private _pendingSelectionStart: { x: number; y: number; event: MouseEvent } | null = null;
  private readonly _DRAG_THRESHOLD_PX = 4; // Minimum pixels to move before starting selection

  constructor(config: SelectionManagerConfig) {
    this._config = config;
    this._model = new SelectionModel(() => config.getDimensions().cols);

    // Bind listeners for cleanup
    this._mouseMoveListener = (e) => this._handleMouseMove(e);
    this._mouseUpListener = (e) => this._handleMouseUp(e);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Check if there's an active selection (non-empty)
   */
  public get hasSelection(): boolean {
    const start = this._model.finalSelectionStart;
    const end = this._model.finalSelectionEnd;
    if (!start || !end) return false;
    return start[0] !== end[0] || start[1] !== end[1];
  }

  /**
   * Check if currently selecting (dragging)
   */
  public isSelecting(): boolean {
    return this._isSelecting;
  }

  /**
   * Disable selection (when terminal has mouse tracking)
   */
  public disable(): void {
    this.clearSelection();
    this._enabled = false;
  }

  /**
   * Enable selection
   */
  public enable(): void {
    this._enabled = true;
  }

  /**
   * Clear current selection
   */
  public clearSelection(): void {
    this._model.clearSelection();
    this._removeMouseDownListeners();
    this._activeSelectionMode = SelectionMode.NORMAL;
    this._setIsSelecting(false);
    this._pendingSelectionStart = null;
    this._refresh();
  }

  /**
   * Get selected text from buffer
   */
  public getSelectedText(): string {
    const start = this._model.finalSelectionStart;
    const end = this._model.finalSelectionEnd;

    if (!start || !end) return '';

    const result: string[] = [];
    const isColumnMode = this._activeSelectionMode === SelectionMode.COLUMN;

    if (isColumnMode) {
      // Block selection: same columns on each row
      if (start[0] === end[0]) return ''; // Zero width

      const startCol = Math.min(start[0], end[0]);
      const endCol = Math.max(start[0], end[0]);

      for (let row = start[1]; row <= end[1]; row++) {
        const lineText = this._config.getLineText(row);
        result.push(lineText.substring(startCol, endCol));
      }
    } else {
      // Linear selection
      // First row
      const startRowEndCol = start[1] === end[1] ? end[0] : undefined;
      const firstLine = this._config.getLineText(start[1]);
      result.push(firstLine.substring(start[0], startRowEndCol));

      // Middle rows (full lines)
      for (let row = start[1] + 1; row < end[1]; row++) {
        const lineText = this._config.getLineText(row);
        // TODO: Check isWrapped flag and concatenate if wrapped
        result.push(lineText);
      }

      // Last row (if different from first)
      if (start[1] !== end[1]) {
        const lastLine = this._config.getLineText(end[1]);
        result.push(lastLine.substring(0, end[0]));
      }
    }

    return result.join('\n');
  }

  /**
   * Set block selection mode (for Alt key toggle)
   */
  public setBlockMode(enabled: boolean): void {
    if (enabled && this._activeSelectionMode !== SelectionMode.COLUMN) {
      this._activeSelectionMode = SelectionMode.COLUMN;
      this._refresh();
    } else if (!enabled && this._activeSelectionMode === SelectionMode.COLUMN) {
      // Don't reset mode if we have a completed selection (not actively selecting)
      // This preserves block mode for Cmd+C copy after Alt is released
      if (this.hasSelection && !this._isSelecting) {
        return;
      }
      this._activeSelectionMode = SelectionMode.NORMAL;
      this._refresh();
    }
  }

  /**
   * Get current block mode state
   */
  public getBlockMode(): boolean {
    return this._activeSelectionMode === SelectionMode.COLUMN;
  }

  /**
   * Get set of selected cell indices in viewport coordinates.
   * Used by renderer for JS-based selection highlighting.
   *
   * @returns Set of cell indices (viewportRow * cols + col), or null if no selection
   */
  public getSelectedCellIndices(): Set<number> | null {
    const start = this._model.finalSelectionStart;
    const end = this._model.finalSelectionEnd;

    if (!start || !end) return null;

    // Check if selection is empty
    if (start[0] === end[0] && start[1] === end[1]) return null;

    const dims = this._config.getDimensions();
    const viewportY = Math.floor(this._config.getViewportY());
    const scrollbackLength = this._config.getScrollbackLength();

    // Calculate visible line range in buffer coordinates
    const topLineIndex = scrollbackLength - viewportY;
    const bottomLineIndex = topLineIndex + dims.rows - 1;

    // Determine selection bounds
    const minRow = Math.min(start[1], end[1]);
    const maxRow = Math.max(start[1], end[1]);

    // Check if selection intersects viewport
    if (maxRow < topLineIndex || minRow > bottomLineIndex) {
      return null;
    }

    const result = new Set<number>();
    const isColumnMode = this._activeSelectionMode === SelectionMode.COLUMN;

    if (isColumnMode) {
      // Block selection: same columns on each row
      const startCol = Math.min(start[0], end[0]);
      const endCol = Math.max(start[0], end[0]);

      for (let bufferRow = minRow; bufferRow <= maxRow; bufferRow++) {
        // Convert buffer row to viewport row
        const viewportRow = bufferRow - scrollbackLength + viewportY;

        // Skip if outside viewport
        if (viewportRow < 0 || viewportRow >= dims.rows) continue;

        // Add all cells in the column range for this row
        for (let col = startCol; col < endCol; col++) {
          result.add(viewportRow * dims.cols + col);
        }
      }
    } else {
      // Linear selection
      for (let bufferRow = minRow; bufferRow <= maxRow; bufferRow++) {
        // Convert buffer row to viewport row
        const viewportRow = bufferRow - scrollbackLength + viewportY;

        // Skip if outside viewport
        if (viewportRow < 0 || viewportRow >= dims.rows) continue;

        // Determine column range for this row
        let colStart: number;
        let colEnd: number;

        if (bufferRow === minRow && bufferRow === maxRow) {
          // Single row selection
          colStart = Math.min(start[0], end[0]);
          colEnd = Math.max(start[0], end[0]);
        } else if (bufferRow === minRow) {
          // First row: from start col to end of line
          colStart = (start[1] < end[1]) ? start[0] : end[0];
          colEnd = dims.cols;
        } else if (bufferRow === maxRow) {
          // Last row: from start of line to end col
          colStart = 0;
          colEnd = (start[1] > end[1]) ? start[0] : end[0];
        } else {
          // Middle row: full line
          colStart = 0;
          colEnd = dims.cols;
        }

        // Add all cells in the column range
        for (let col = colStart; col < colEnd; col++) {
          result.add(viewportRow * dims.cols + col);
        }
      }
    }

    return result.size > 0 ? result : null;
  }

  // ==========================================================================
  // Mouse Event Handlers
  // ==========================================================================

  /**
   * Handle mouse down - entry point for selection
   * @returns true if event was handled (should preventDefault)
   */
  public onMouseDown(event: MouseEvent): boolean {
    // Store container for coordinate calculations
    if (!this._containerElement && event.currentTarget instanceof HTMLElement) {
      this._containerElement = event.currentTarget;
    }

    // Clear any pending selection from previous interaction
    this._pendingSelectionStart = null;

    // Right-click with existing selection: allow context menu
    if (event.button === 2 && this.hasSelection) {
      return false;
    }

    // Only handle primary button
    if (event.button !== 0) {
      return false;
    }

    // Check selection mode requirements
    const requireShift = this._config.getRequireShift();

    // Check if mouse tracking is active (for terminal apps like vim, irssi, MC)
    const hasMouseTracking = this._config.hasMouseTracking();

    // Selection vs Mouse Tracking decision:
    //
    // | requireShift | mouseTracking | Shift | Behavior |
    // |--------------|---------------|-------|----------|
    // | true         | ON            | No    | Click → app |
    // | true         | ON            | Yes   | Immediate selection |
    // | true         | OFF           | No    | No selection |
    // | true         | OFF           | Yes   | Immediate selection |
    // | false        | ON            | No    | Drag → selection, Click → app |
    // | false        | ON            | Yes   | Immediate selection (force) |
    // | false        | OFF           | *     | Immediate selection |

    if (hasMouseTracking) {
      if (requireShift) {
        // Shift mode + mouse tracking: need Shift to force selection
        if (!event.shiftKey) {
          // Clear any existing selection on click
          if (this.hasSelection) {
            this.clearSelection();
          }
          return false; // Let InputHandler send mouse events to terminal app
        }
        // Shift pressed - selection takes priority over mouse tracking
      } else {
        // Direct mode + mouse tracking:
        // - Shift+click: immediate selection (force)
        // - Normal click: wait for drag, let click go to app
        if (!event.shiftKey) {
          // Clear any existing selection on click (before potential new drag-to-select)
          if (this.hasSelection) {
            this.clearSelection();
          }
          // Store pending selection start - we'll start selection on drag
          this._pendingSelectionStart = {
            x: event.clientX,
            y: event.clientY,
            event: event
          };
          // Add document listeners to detect drag
          this._addMouseDownListeners();
          // Return false - let InputHandler send mousedown to app
          // Selection will start on mousemove if user drags
          return false;
        }
        // Shift pressed - immediate selection
      }
    }

    // In "Shift mode" without mouse tracking, still need Shift to start selection
    if (requireShift && !hasMouseTracking && !event.shiftKey) {
      // Still clear existing selection on click (even without Shift)
      if (this.hasSelection) {
        this.clearSelection();
      }
      return false;
    }

    // Prevent text selection
    event.preventDefault();

    // Reset drag scroll
    this._dragScrollAmount = 0;

    // Shift+click extends existing selection ONLY in "Direct" mode (requireShift=false)
    // In "Shift mode" (requireShift=true), Shift is used to START selection, not extend
    const shouldExtendSelection = !requireShift && event.shiftKey && this._model.selectionStart;

    if (shouldExtendSelection) {
      this._handleIncrementalClick(event);
    } else {
      // Clear previous selection when starting new one
      this._model.clearSelection();

      // Use event.detail for click count (browser tracks multi-clicks)
      switch (event.detail) {
        case 1:
          this._handleSingleClick(event);
          break;
        case 2:
          this._handleDoubleClick(event);
          break;
        case 3:
          this._handleTripleClick(event);
          break;
        default:
          this._handleSingleClick(event);
      }
    }

    this._setIsSelecting(true);
    this._addMouseDownListeners();
    this._refresh();
    return true;
  }

  /**
   * Handle mouse move during selection
   */
  public onMouseMove(event: MouseEvent): void {
    // Check if we have a pending selection start (drag-to-select for apps with mouse tracking)
    if (this._pendingSelectionStart && !this._isSelecting) {
      const dx = event.clientX - this._pendingSelectionStart.x;
      const dy = event.clientY - this._pendingSelectionStart.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance >= this._DRAG_THRESHOLD_PX) {
        // User has dragged enough - start selection now
        const startEvent = this._pendingSelectionStart.event;
        this._pendingSelectionStart = null;

        // Initialize selection from the original mousedown position
        this._model.clearSelection();
        this._model.selectionStartLength = 0;
        this._activeSelectionMode = this._shouldColumnSelect(startEvent)
          ? SelectionMode.COLUMN
          : SelectionMode.NORMAL;

        const startCoords = this._getMouseBufferCoords(startEvent);
        if (startCoords) {
          this._model.selectionStart = startCoords;
          this._model.selectionEnd = undefined;
        }

        this._setIsSelecting(true);
        this._dragScrollAmount = 0;

        // Now continue with normal selection extension
      } else {
        // Not enough drag yet - wait for more movement
        return;
      }
    }

    if (!this._isSelecting) return;

    this._lastMouseEvent = event;

    // Note: We do NOT use stopPropagation() here
    // InputHandler will check isSelecting() and skip sending mouse events to PTY

    // Get buffer coordinates
    const bufferCoords = this._getMouseBufferCoords(event);
    if (!bufferCoords) {
      this._refresh();
      return;
    }

    // Update selection end
    this._model.selectionEnd = bufferCoords;

    // Expand based on mode
    if (this._activeSelectionMode === SelectionMode.LINE) {
      this._expandToLine(bufferCoords);
    } else if (this._activeSelectionMode === SelectionMode.WORD) {
      this._selectToWordAt(bufferCoords);
    }

    // Calculate drag scroll amount
    this._dragScrollAmount = this._getMouseEventScrollAmount(event);

    // Adjust end column for edge scrolling (not in column mode)
    if (this._activeSelectionMode !== SelectionMode.COLUMN) {
      const dims = this._config.getDimensions();
      if (this._dragScrollAmount > 0) {
        this._model.selectionEnd![0] = dims.cols;
      } else if (this._dragScrollAmount < 0) {
        this._model.selectionEnd![0] = 0;
      }
    }

    this._refresh();
  }

  /**
   * Handle mouse up - finalize selection
   */
  public onMouseUp(event: MouseEvent): void {
    // Clear pending selection if user clicked without dragging
    if (this._pendingSelectionStart) {
      this._pendingSelectionStart = null;
      this._removeMouseDownListeners();
      return;
    }

    if (!this._isSelecting) return;

    this._removeMouseDownListeners();
    this._setIsSelecting(false);

    // Copy to clipboard if we have selection
    if (this.hasSelection) {
      const text = this.getSelectedText();
      if (text && this._config.renderer?.copyToClipboard) {
        this._config.renderer.copyToClipboard(text);
      }
    }

    this._refresh();
  }

  /**
   * Handle wheel during selection (allows scrolling while selecting)
   * @returns true if handled
   */
  public onWheel(event: WheelEvent): boolean {
    if (!this._isSelecting) return false;

    // Scroll viewport
    const scrollLines = Math.sign(event.deltaY) * 3;
    this._config.scrollBy(scrollLines);

    // Update selection end after scroll
    if (this._lastMouseEvent) {
      const bufferCoords = this._getMouseBufferCoords(this._lastMouseEvent);
      if (bufferCoords) {
        this._model.selectionEnd = bufferCoords;
        this._refresh();
      }
    }

    return true;
  }

  /**
   * Handle viewport scroll (called by Terminal)
   */
  public onViewportScroll(): void {
    if (this._isSelecting || this.hasSelection) {
      this._refresh();
    }
  }

  // ==========================================================================
  // Internal: Click Handlers
  // ==========================================================================

  /**
   * Handle single click - start new selection
   */
  private _handleSingleClick(event: MouseEvent): void {
    this._model.selectionStartLength = 0;
    this._activeSelectionMode = this._shouldColumnSelect(event)
      ? SelectionMode.COLUMN
      : SelectionMode.NORMAL;

    const coords = this._getMouseBufferCoords(event);
    if (!coords) return;

    this._model.selectionStart = coords;
    this._model.selectionEnd = undefined;
  }

  /**
   * Handle double-click - word selection
   */
  private _handleDoubleClick(event: MouseEvent): void {
    const coords = this._getMouseBufferCoords(event);
    if (!coords) return;

    if (this._selectWordAtCursor(coords)) {
      this._activeSelectionMode = SelectionMode.WORD;
    }
  }

  /**
   * Handle triple-click - line selection
   */
  private _handleTripleClick(event: MouseEvent): void {
    const coords = this._getMouseBufferCoords(event);
    if (!coords) return;

    this._activeSelectionMode = SelectionMode.LINE;
    this._selectLineAt(coords[1]);
  }

  /**
   * Handle Shift+click - extend selection
   */
  private _handleIncrementalClick(event: MouseEvent): void {
    if (!this._model.selectionStart) return;

    const coords = this._getMouseBufferCoords(event);
    if (coords) {
      this._model.selectionEnd = coords;
    }
  }

  // ==========================================================================
  // Internal: Document Listeners
  // ==========================================================================

  /**
   * Add document-level listeners for mouse tracking outside container
   */
  private _addMouseDownListeners(): void {
    document.addEventListener('mousemove', this._mouseMoveListener);
    document.addEventListener('mouseup', this._mouseUpListener);

    // Start drag scroll timer
    this._dragScrollIntervalTimer = window.setInterval(
      () => this._dragScroll(),
      DRAG_SCROLL_INTERVAL
    );
  }

  /**
   * Remove document-level listeners
   */
  private _removeMouseDownListeners(): void {
    document.removeEventListener('mousemove', this._mouseMoveListener);
    document.removeEventListener('mouseup', this._mouseUpListener);

    if (this._dragScrollIntervalTimer !== undefined) {
      clearInterval(this._dragScrollIntervalTimer);
      this._dragScrollIntervalTimer = undefined;
    }
  }

  /**
   * Internal mousemove handler (bound to document)
   */
  private _handleMouseMove(event: MouseEvent): void {
    this.onMouseMove(event);
  }

  /**
   * Internal mouseup handler (bound to document)
   */
  private _handleMouseUp(event: MouseEvent): void {
    this.onMouseUp(event);
  }

  // ==========================================================================
  // Internal: Drag Scroll
  // ==========================================================================

  /**
   * Calculate scroll amount based on mouse position relative to viewport
   */
  private _getMouseEventScrollAmount(event: MouseEvent): number {
    if (!this._containerElement) return 0;

    const rect = this._containerElement.getBoundingClientRect();
    let offset = event.clientY - rect.top;
    const height = rect.height;

    // Inside viewport - no scroll
    if (offset >= 0 && offset <= height) {
      return 0;
    }

    // Below viewport
    if (offset > height) {
      offset -= height;
    }

    // Clamp and scale
    offset = Math.min(Math.max(offset, -DRAG_SCROLL_MAX_THRESHOLD), DRAG_SCROLL_MAX_THRESHOLD);
    offset /= DRAG_SCROLL_MAX_THRESHOLD;

    // Calculate scroll speed (1 to DRAG_SCROLL_MAX_SPEED)
    return Math.sign(offset) + Math.round(offset * (DRAG_SCROLL_MAX_SPEED - 1));
  }

  /**
   * Drag scroll callback (called by setInterval)
   */
  private _dragScroll(): void {
    if (!this._model.selectionStart || !this._model.selectionEnd) return;
    if (this._dragScrollAmount === 0) return;

    // Scroll viewport
    this._config.scrollBy(this._dragScrollAmount);

    // Update selection end to viewport edge
    const dims = this._config.getDimensions();
    const scrollbackLength = this._config.getScrollbackLength();
    const viewportY = this._config.getViewportY();

    if (this._dragScrollAmount > 0) {
      // Scrolling down (toward current output)
      if (this._activeSelectionMode !== SelectionMode.COLUMN) {
        this._model.selectionEnd[0] = dims.cols;
      }
      // Bottom of viewport in buffer coordinates
      const bottomLineIndex = scrollbackLength - Math.floor(viewportY) + dims.rows - 1;
      this._model.selectionEnd[1] = Math.min(bottomLineIndex, scrollbackLength + dims.rows - 1);
    } else {
      // Scrolling up (into history)
      if (this._activeSelectionMode !== SelectionMode.COLUMN) {
        this._model.selectionEnd[0] = 0;
      }
      // Top of viewport in buffer coordinates
      const topLineIndex = scrollbackLength - Math.floor(viewportY);
      this._model.selectionEnd[1] = Math.max(topLineIndex, 0);
    }

    this._refresh();
  }

  // ==========================================================================
  // Internal: Coordinate Conversion
  // ==========================================================================

  /**
   * Convert mouse event to buffer coordinates [col, row]
   * Row is absolute line index (0 = oldest scrollback line)
   */
  private _getMouseBufferCoords(event: MouseEvent): [number, number] | undefined {
    const viewportCoords = this._getMouseViewportCoords(event);
    if (!viewportCoords) return undefined;

    const [col, viewportRow] = viewportCoords;
    const scrollbackLength = this._config.getScrollbackLength();
    const viewportY = Math.floor(this._config.getViewportY());

    // Convert viewport row to absolute buffer line index
    // lineIndex = scrollbackLength - viewportY + viewportRow
    const lineIndex = scrollbackLength - viewportY + viewportRow;

    return [col, lineIndex];
  }

  /**
   * Convert mouse event to viewport coordinates [col, row]
   * Row is 0-based from top of visible area
   */
  private _getMouseViewportCoords(event: MouseEvent): [number, number] | undefined {
    if (!this._containerElement) return undefined;

    const dims = this._config.getDimensions();
    const cellDims = this._config.getCellDimensions();

    if (cellDims.width <= 0 || cellDims.height <= 0) return undefined;

    const rect = this._containerElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Convert to cell coordinates
    let col = Math.floor(x / cellDims.width);
    let row = Math.floor(y / cellDims.height);

    // Clamp to valid range
    col = Math.max(0, Math.min(dims.cols - 1, col));
    row = Math.max(0, Math.min(dims.rows - 1, row));

    return [col, row];
  }

  /**
   * Convert buffer coordinates to viewport coordinates
   * @returns null if outside visible viewport
   */
  private _bufferToViewportCoords(col: number, bufferRow: number): [number, number] | null {
    const dims = this._config.getDimensions();
    const viewportY = Math.floor(this._config.getViewportY());
    const scrollbackLength = this._config.getScrollbackLength();

    // viewportRow = bufferRow - scrollbackLength + viewportY
    const viewportRow = bufferRow - scrollbackLength + viewportY;

    if (viewportRow < 0 || viewportRow >= dims.rows) {
      return null;
    }

    return [col, viewportRow];
  }

  // ==========================================================================
  // Internal: Selection State
  // ==========================================================================

  /**
   * Set selection state and notify renderer (to prevent frame skipping)
   */
  private _setIsSelecting(value: boolean): void {
    this._isSelecting = value;
    // Notify renderer to prevent frame skipping during selection
    this._config.renderer?.setIsSelecting?.(value);
  }

  // ==========================================================================
  // Internal: Selection Helpers
  // ==========================================================================

  /**
   * Should force selection despite mouse tracking? (Shift key override)
   */
  private _shouldForceSelection(event: MouseEvent): boolean {
    // Shift always forces selection
    return event.shiftKey;
  }

  /**
   * Should use column/block selection? (Alt key)
   */
  private _shouldColumnSelect(event: MouseEvent): boolean {
    return event.altKey;
  }

  /**
   * Select word at cursor position
   */
  private _selectWordAtCursor(coords: [number, number]): boolean {
    const wordPos = this._getWordAt(coords);
    if (!wordPos) return false;

    this._model.selectionStart = [wordPos.start, coords[1]];
    this._model.selectionStartLength = wordPos.length;
    this._model.selectionEnd = undefined;
    return true;
  }

  /**
   * Expand selection end to word at position
   */
  private _selectToWordAt(coords: [number, number]): void {
    const wordPos = this._getWordAt(coords);
    if (!wordPos) return;

    // Determine which end of the word to use based on direction
    if (!this._model.areSelectionValuesReversed()) {
      // Selecting forward - use end of word
      this._model.selectionEnd = [wordPos.start + wordPos.length, coords[1]];
    } else {
      // Selecting backward - use start of word
      this._model.selectionEnd = [wordPos.start, coords[1]];
    }
  }

  /**
   * Get word position at coordinates
   */
  private _getWordAt(coords: [number, number]): IWordPosition | undefined {
    const dims = this._config.getDimensions();
    if (coords[0] >= dims.cols) return undefined;

    const line = this._config.getLineText(coords[1]);
    if (!line || coords[0] >= line.length) return undefined;

    const char = line.charAt(coords[0]);

    // If on whitespace, expand to cover consecutive whitespace
    if (char === ' ' || char === '\t') {
      let startIndex = coords[0];
      let endIndex = coords[0];

      while (startIndex > 0 && (line.charAt(startIndex - 1) === ' ' || line.charAt(startIndex - 1) === '\t')) {
        startIndex--;
      }
      while (endIndex < line.length - 1 && (line.charAt(endIndex + 1) === ' ' || line.charAt(endIndex + 1) === '\t')) {
        endIndex++;
      }

      return { start: startIndex, length: endIndex - startIndex + 1 };
    }

    // Find word boundaries
    let startIndex = coords[0];
    let endIndex = coords[0];

    // Expand left
    while (startIndex > 0 && !this._isWordSeparator(line.charAt(startIndex - 1))) {
      startIndex--;
    }

    // Expand right
    while (endIndex < line.length - 1 && !this._isWordSeparator(line.charAt(endIndex + 1))) {
      endIndex++;
    }

    return { start: startIndex, length: endIndex - startIndex + 1 };
  }

  /**
   * Check if character is a word separator
   */
  private _isWordSeparator(char: string): boolean {
    return WORD_SEPARATORS.includes(char);
  }

  /**
   * Select entire line at row
   */
  private _selectLineAt(row: number): void {
    const dims = this._config.getDimensions();

    this._model.selectionStart = [0, row];
    this._model.selectionEnd = undefined;
    this._model.selectionStartLength = dims.cols;
  }

  /**
   * Expand selection end to full line
   */
  private _expandToLine(coords: [number, number]): void {
    const dims = this._config.getDimensions();
    const start = this._model.selectionStart;

    if (!start) return;

    // Determine direction
    if (coords[1] < start[1]) {
      // Selecting upward
      this._model.selectionEnd = [0, coords[1]];
    } else {
      // Selecting downward
      this._model.selectionEnd = [dims.cols, coords[1]];
    }
  }

  // ==========================================================================
  // Internal: Renderer Integration
  // ==========================================================================

  /**
   * Refresh selection display (uses requestAnimationFrame)
   */
  private _refresh(): void {
    if (this._refreshAnimationFrame) return;

    this._refreshAnimationFrame = requestAnimationFrame(() => {
      this._refreshAnimationFrame = undefined;
      this._updateRendererSelection();
    });
  }

  /**
   * Update renderer with current selection
   *
   * Note: With JS-based selection rendering, we don't call beamterm's
   * setSelectionRange/clearSelection anymore. Selection is rendered
   * by the renderer via getSelectedCells callback in processCell().
   * This method is kept for potential future use and just triggers
   * a re-render through the render loop.
   */
  private _updateRendererSelection(): void {
    // JS-based selection rendering: selection is drawn by the renderer
    // via the getSelectedCells callback in render(). We don't need to
    // call beamterm's selection API anymore.
    //
    // The render loop will automatically pick up the updated selection
    // from SelectionManager.getSelectedCellIndices() on the next frame.
  }
}
