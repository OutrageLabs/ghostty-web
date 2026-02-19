/**
 * SelectionModel - Data model for terminal text selection
 *
 * Based on xterm.js SelectionModel pattern.
 * Tracks selection start/end coordinates and handles normalization.
 *
 * Coordinates are in buffer space:
 * - [col, row] where row is absolute line index (0 = oldest scrollback line)
 */

export class SelectionModel {
  /**
   * The [col, row] position where selection starts
   */
  public selectionStart: [number, number] | undefined;

  /**
   * The [col, row] position where selection ends
   */
  public selectionEnd: [number, number] | undefined;

  /**
   * Minimal selection length from start (for word/line selection)
   * When double-clicking a word, this tracks the word length so
   * dragging backwards still includes the full word.
   */
  public selectionStartLength: number = 0;

  constructor(private _getCols: () => number) {}

  /**
   * Clear all selection state
   */
  public clearSelection(): void {
    this.selectionStart = undefined;
    this.selectionEnd = undefined;
    this.selectionStartLength = 0;
  }

  /**
   * Get the final selection start, normalized for direction
   * Returns the earlier position (lower row, or same row with lower col)
   */
  public get finalSelectionStart(): [number, number] | undefined {
    if (!this.selectionEnd || !this.selectionStart) {
      return this.selectionStart;
    }
    return this.areSelectionValuesReversed() ? this.selectionEnd : this.selectionStart;
  }

  /**
   * Get the final selection end, accounting for selectionStartLength
   * Returns the later position, extended by selectionStartLength if needed
   */
  public get finalSelectionEnd(): [number, number] | undefined {
    if (!this.selectionStart) {
      return undefined;
    }

    // If no end or reversed, use start + length
    if (!this.selectionEnd || this.areSelectionValuesReversed()) {
      const startPlusLength = this.selectionStart[0] + this.selectionStartLength;
      const cols = this._getCols();

      // Handle wrapping to next lines
      if (startPlusLength > cols) {
        // Handle edge case: selection ends exactly at line end
        if (startPlusLength % cols === 0) {
          return [cols, this.selectionStart[1] + Math.floor(startPlusLength / cols) - 1];
        }
        return [startPlusLength % cols, this.selectionStart[1] + Math.floor(startPlusLength / cols)];
      }
      return [startPlusLength, this.selectionStart[1]];
    }

    // Ensure word/line selection minimum is respected when dragging
    if (this.selectionStartLength > 0) {
      // On same line: use larger of end position or start + length
      if (this.selectionEnd[1] === this.selectionStart[1]) {
        const startPlusLength = this.selectionStart[0] + this.selectionStartLength;
        const cols = this._getCols();

        // Handle wrapping
        if (startPlusLength > cols) {
          return [startPlusLength % cols, this.selectionStart[1] + Math.floor(startPlusLength / cols)];
        }
        return [Math.max(startPlusLength, this.selectionEnd[0]), this.selectionEnd[1]];
      }
    }

    return this.selectionEnd;
  }

  /**
   * Check if selection start and end are reversed (end is before start)
   */
  public areSelectionValuesReversed(): boolean {
    const start = this.selectionStart;
    const end = this.selectionEnd;

    if (!start || !end) {
      return false;
    }

    // Reversed if end row is before start row, or same row but end col is before start col
    return end[1] < start[1] || (end[1] === start[1] && end[0] < start[0]);
  }

  /**
   * Handle buffer trim (scrollback eviction)
   * Adjusts selection coordinates when lines are removed from top
   *
   * @param amount Number of lines trimmed
   * @returns true if selection needs refresh (still visible), false if cleared
   */
  public handleTrim(amount: number): boolean {
    if (this.selectionStart) {
      this.selectionStart[1] -= amount;
    }
    if (this.selectionEnd) {
      this.selectionEnd[1] -= amount;
    }

    // Selection moved off buffer entirely
    if (this.selectionEnd && this.selectionEnd[1] < 0) {
      this.clearSelection();
      return true;
    }

    // Clamp start to buffer beginning
    if (this.selectionStart && this.selectionStart[1] < 0) {
      this.selectionStart[1] = 0;
    }

    return false;
  }
}
