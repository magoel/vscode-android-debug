/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
export type IndexIntoStringTable = number;

export class UniqueStringArray {
  _array: string[];
  _stringToIndex: Map<string, IndexIntoStringTable>;

  constructor(originalArray: string[] = []) {
    this._array = originalArray.slice(0);
    this._stringToIndex = new Map();
    for (let i = 0; i < originalArray.length; i++) {
      this._stringToIndex.set(originalArray[i], i);
    }
  }

  getString(index: IndexIntoStringTable, els?: string): string {
    if (!this.hasIndex(index)) {
      if (els) {
        console.warn(`index ${index} not in UniqueStringArray`);
        return els;
      }
      throw new Error(`index ${index} not in UniqueStringArray`);
    }
    return this._array[index];
  }

  hasIndex(i: IndexIntoStringTable): boolean {
    return i in this._array;
  }

  hasString(s: string): boolean {
    return this._stringToIndex.has(s);
  }

  indexForString(s: string): IndexIntoStringTable {
    let index = this._stringToIndex.get(s);
    if (index === undefined) {
      index = this._array.length;
      this._stringToIndex.set(s, index);
      this._array.push(s);
    }
    return index;
  }

  serializeToArray(): string[] {
    return this._array.slice(0);
  }
}
