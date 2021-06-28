import {Input, InputGap} from "@lezer/common"
import {Stack} from "./stack"

export class CachedToken {
  start = -1
  value = -1
  end = -1
  extended = -1
  lookAhead = 0
  mask = 0
  context = 0
}

const nullToken = new CachedToken

/// [Tokenizers](#lr.ExternalTokenizer) interact with the input
/// through this interface. It presents the input as a stream of
/// characters, hiding the complexity of [gaps](#common.InputGap) from
/// tokenizer code and tracking lookahead.
export class InputStream {
  /// @internal
  chunk = ""
  /// @internal
  chunkOff = 0
  /// @internal
  chunkPos: number
  /// Backup chunk
  private chunk2 = ""
  private chunk2Pos = 0

  /// The character code of the next code unit in the input, or -1
  /// when the stream is at the end of the input.
  next: number = -1

  /// @internal
  gaps: null | readonly InputGap[]

  /// @internal
  token = nullToken

  /// The current position of the stream. Note that, due to
  /// [gaps](#common.ParseSpec.gaps), advancing the stream does not
  /// always mean its position moves a single unit.
  pos: number

  /// @internal
  constructor(
    /// @internal
    readonly input: Input,
    /// @internal
    readonly start: number,
    /// @internal
    public end: number,
    gaps: undefined | readonly InputGap[]
  ) {
    this.pos = this.chunkPos = start
    this.gaps = gaps && gaps.length ? gaps : null
    this.readNext()
  }

  private resolvePos(pos: number, offset: number) {
    if (!this.gaps || !offset) return pos + offset
    if (offset < 0) {
      for (let i = this.gaps.length - 1; i >= 0; i--) {
        let gap = this.gaps[i]
        if (gap.to <= pos - offset) break
        if (gap.to <= pos) offset -= gap.to - gap.from
      }
    } else {
      for (let gap of this.gaps) {
        if (gap.from > pos + offset) break
        if (gap.from > pos) offset += gap.to - gap.from
      }
    }
    return pos + offset
  }

  /// Look at a code unit near the stream position. `.peek(0)` equals
  /// `.next`, `.peek(-1)` gives you the previous character, and so
  /// on.
  ///
  /// Note that looking around during tokenizing creates dependencies
  /// on potentially far-away content, which may reduce the
  /// effectiveness incremental parsing—when looking forward—or even
  /// cause invalid reparses when looking backward more than 25 code
  /// units, since the library does not track lookbehind.
  peek(offset: number) {
    let idx = this.chunkOff + offset, pos, result
    if (idx >= 0 && idx < this.chunk.length) {
      pos = this.pos + offset
      result = this.chunk.charCodeAt(idx)
    } else {
      pos = this.resolvePos(this.pos, offset)
      result = pos < this.start || pos >= this.end ? -1 : this.input.read(pos, pos + 1).charCodeAt(0)
    }
    if (pos > this.token.lookAhead) this.token.lookAhead = pos
    return result
  }

  /// Accept a token. By default, the end of the token is set to the
  /// current stream position, but you can pass an offset (relative to
  /// the stream position) to change that.
  acceptToken(token: number, endOffset = 0) {
    this.token.value = token
    this.token.end = this.resolvePos(this.pos, endOffset)
  }

  private getChunk() {
    if (this.pos >= this.chunk2Pos && this.pos < this.chunk2Pos + this.chunk2.length) {
      let {chunk, chunkPos} = this
      this.chunk = this.chunk2; this.chunkPos = this.chunk2Pos
      this.chunk2 = chunk; this.chunk2Pos = chunkPos
      this.chunkOff = this.pos - this.chunkPos
      return true
    }
    if (this.pos >= this.end) {
      this.next = -1
      this.chunk = ""
      this.chunkOff = 0
      return false
    }
    this.chunk2 = this.chunk; this.chunk2Pos = this.chunkPos
    let nextChunk = this.input.chunk(this.pos)
    let end = this.pos + nextChunk.length
    this.chunk = end > this.end ? nextChunk.slice(0, this.end - this.pos) : nextChunk
    this.chunkPos = this.pos
    this.chunkOff = 0
    return this.gaps ? this.removeGapsFromChunk() : true
  }

  private removeGapsFromChunk(): boolean {
    let from = this.pos, to = this.pos + this.chunk.length
    for (let g of this.gaps!) {
      if (g.from >= to) break
      if (g.to > from) {
        if (from < g.from) {
          this.chunk = this.chunk.slice(0, g.from - from)
          return true
        } else {
          this.pos = this.chunkPos = g.to
          if (to > g.to) {
            this.chunk = this.chunk.slice(g.to - from)
            from = g.to
          } else {
            this.chunk = ""
            return this.getChunk()
          }
        }
      }
    }
    return true
  }

  private readNext() {
    if (this.chunkOff == this.chunk.length) {
      if (!this.getChunk()) return
    }
    this.next = this.chunk.charCodeAt(this.chunkOff)
  }

  /// Move the stream forward N (defaults to 1) code units. Returns
  /// the new value of [`next`](#lr.InputStream.next).
  advance(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.next < 0) return -1
      this.chunkOff++
      this.pos++
      if (this.pos > this.token.lookAhead) this.token.lookAhead = this.pos
      this.readNext()
    }
    return this.next
  }

  /// @internal
  reset(pos: number, token?: CachedToken) {
    if (token) {
      this.token = token
      token.start = token.lookAhead = pos
      token.value = token.extended = -1
    } else {
      this.token = nullToken
    }
    if (this.pos != pos) {
      this.pos = pos
      if (pos >= this.chunkPos && pos < this.chunkPos + this.chunk.length) {
        this.chunkOff = pos - this.chunkPos
      } else {
        this.chunk = ""
        this.chunkOff = 0
      }
      this.readNext()
    }
    return this
  }

  /// @internal
  read(from: number, to: number) {
    let val = from >= this.chunkPos && to <= this.chunkPos + this.chunk.length
      ? this.chunk.slice(from - this.chunkPos, to - this.chunkPos)
      : this.input.read(from, to)
    if (this.gaps) {
      for (let i = this.gaps.length - 1; i >= 0; i--) {
        let g = this.gaps[i]
        if (g.to > from && g.from < to)
          val = val.slice(0, Math.max(0, g.from - from)) + val.slice(Math.min(val.length, g.to - from))
      }
    }
    return val
  }
}

export interface Tokenizer {
  token(input: InputStream, stack: Stack): void
  contextual: boolean
  fallback: boolean
  extend: boolean
}

/// @internal
export class TokenGroup implements Tokenizer {
  contextual!: boolean
  fallback!: boolean
  extend!: boolean

  constructor(readonly data: Readonly<Uint16Array>, readonly id: number) {}

  token(input: InputStream, stack: Stack) { readToken(this.data, input, stack, this.id) }
}

TokenGroup.prototype.contextual = TokenGroup.prototype.fallback = TokenGroup.prototype.extend = false

interface ExternalOptions {
  /// When set to true, mark this tokenizer as depending on the
  /// current parse stack, which prevents its result from being cached
  /// between parser actions at the same positions.
  contextual?: boolean,
  /// By defaults, when a tokenizer returns a token, that prevents
  /// tokenizers with lower precedence from even running. When
  /// `fallback` is true, the tokenizer is allowed to run when a
  /// previous tokenizer returned a token that didn't match any of the
  /// current state's actions.
  fallback?: boolean
  /// When set to true, tokenizing will not stop after this tokenizer
  /// has produced a token. (But it will still fail to reach this one
  /// if a higher-precedence tokenizer produced a token.)
  extend?: boolean
}

/// `@external tokens` declarations in the grammar should resolve to
/// an instance of this class.
export class ExternalTokenizer implements Tokenizer {
  contextual: boolean
  fallback: boolean
  extend: boolean

  /// Create a tokenizer. The first argument is the function that,
  /// given an input stream, scans for the types of tokens it
  /// recognizes at the stream's position, and calls
  /// [`acceptToken`](#lr.InputStream.acceptToken) when it finds
  /// one.
  constructor(
    readonly token: (input: InputStream, stack: Stack) => void,
    options: ExternalOptions = {}
  ) {
    this.contextual = !!options.contextual
    this.fallback = !!options.fallback
    this.extend = !!options.extend
  }
}

// Tokenizer data is stored a big uint16 array containing, for each
// state:
//
//  - A group bitmask, indicating what token groups are reachable from
//    this state, so that paths that can only lead to tokens not in
//    any of the current groups can be cut off early.
//
//  - The position of the end of the state's sequence of accepting
//    tokens
//
//  - The number of outgoing edges for the state
//
//  - The accepting tokens, as (token id, group mask) pairs
//
//  - The outgoing edges, as (start character, end character, state
//    index) triples, with end character being exclusive
//
// This function interprets that data, running through a stream as
// long as new states with the a matching group mask can be reached,
// and updating `token` when it matches a token.
function readToken(data: Readonly<Uint16Array>,
                   input: InputStream,
                   stack: Stack,
                   group: number) {
  let state = 0, groupMask = 1 << group, {parser} = stack.p, {dialect} = parser
  scan: for (;;) {
    if ((groupMask & data[state]) == 0) break
    let accEnd = data[state + 1]
    // Check whether this state can lead to a token in the current group
    // Accept tokens in this state, possibly overwriting
    // lower-precedence / shorter tokens
    for (let i = state + 3; i < accEnd; i += 2) if ((data[i + 1] & groupMask) > 0) {
      let term = data[i]
      if (dialect.allows(term) &&
          (input.token.value == -1 || input.token.value == term || parser.overrides(term, input.token.value))) {
        input.acceptToken(term)
        break
      }
    }
    // Do a binary search on the state's edges
    for (let next = input.next, low = 0, high = data[state + 2]; low < high;) {
      let mid = (low + high) >> 1
      let index = accEnd + mid + (mid << 1)
      let from = data[index], to = data[index + 1]
      if (next < from) high = mid
      else if (next >= to) low = mid + 1
      else { state = data[index + 2]; input.advance(); continue scan }
    }
    break
  }
}
