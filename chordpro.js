/* chordpro.js — parse ChordPro text into a lightweight AST, render to DOM, transpose chords. */

const ChordPro = (() => {

  const SHARP_SCALE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const FLAT_SCALE  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const NOTE_INDEX = {};
  SHARP_SCALE.forEach((n,i) => NOTE_INDEX[n] = i);
  FLAT_SCALE.forEach((n,i) => NOTE_INDEX[n] = i);

  // Extract metadata (title etc.) quickly without full render — used for list/search.
  function extractMeta(text) {
    const meta = { title: null, subtitle: null, artist: null, key: null, capo: null };
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}\s*$/);
      if (!m) continue;
      const dir = m[1].toLowerCase();
      const val = m[2];
      if ((dir === 'title' || dir === 't') && !meta.title) meta.title = val;
      else if ((dir === 'subtitle' || dir === 'st') && !meta.subtitle) meta.subtitle = val;
      else if (dir === 'artist' && !meta.artist) meta.artist = val;
      else if (dir === 'key' && !meta.key) meta.key = val;
      else if (dir === 'capo' && !meta.capo) meta.capo = val;
    }
    return meta;
  }

  // Parse a single lyric+chord line into segments: [{chord, text}, ...]
  function parseLine(line) {
    const segments = [];
    let lastIndex = 0;
    const re = /\[([^\]]*)\]/g;
    let match;
    let pendingChord = null;
    let found = false;
    while ((match = re.exec(line)) !== null) {
      found = true;
      const textBefore = line.slice(lastIndex, match.index);
      if (textBefore !== '' || pendingChord !== null) {
        segments.push({ chord: pendingChord, text: textBefore });
      }
      pendingChord = match[1];
      lastIndex = re.lastIndex;
    }
    if (found) {
      const rest = line.slice(lastIndex);
      segments.push({ chord: pendingChord, text: rest || '\u00A0' });
    }
    return { hasChords: found, segments, raw: line };
  }

  const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z_#]+)\s*:?\s*(.*?)\s*\}\s*$/;

  // Parse full document into a block structure for rendering.
  function parse(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let currentEnv = null; // {type: 'chorus'|'bridge'|'tab'|'verse', lines: []}

    const pushLine = (item) => {
      if (currentEnv) currentEnv.lines.push(item);
      else blocks.push(item);
    };

    for (let raw of lines) {
      const dMatch = raw.match(DIRECTIVE_RE);
      if (dMatch) {
        const dir = dMatch[1].toLowerCase();
        const val = dMatch[2];
        switch (dir) {
          case 'title': case 't':
            blocks.push({ type: 'title', text: val }); continue;
          case 'subtitle': case 'st':
            blocks.push({ type: 'subtitle', text: val }); continue;
          case 'artist':
            blocks.push({ type: 'artist', text: val }); continue;
          case 'key':
            blocks.push({ type: 'key', text: val }); continue;
          case 'capo':
            blocks.push({ type: 'capo', text: val }); continue;
          case 'comment': case 'c': case 'comment_italic': case 'ci': case 'comment_box': case 'cb':
            pushLine({ type: 'comment', text: val }); continue;
          case 'soc': case 'start_of_chorus':
            currentEnv = { type: 'chorus', lines: [], label: val || 'Chorus' }; continue;
          case 'eoc': case 'end_of_chorus':
            if (currentEnv) { blocks.push(currentEnv); currentEnv = null; } continue;
          case 'sob': case 'start_of_bridge':
            currentEnv = { type: 'bridge', lines: [], label: val || 'Bridge' }; continue;
          case 'eob': case 'end_of_bridge':
            if (currentEnv) { blocks.push(currentEnv); currentEnv = null; } continue;
          case 'sot': case 'start_of_tab':
            currentEnv = { type: 'tab', lines: [], label: val || 'Tab' }; continue;
          case 'eot': case 'end_of_tab':
            if (currentEnv) { blocks.push(currentEnv); currentEnv = null; } continue;
          case 'sov': case 'start_of_verse':
            currentEnv = { type: 'verse', lines: [], label: val || 'Verse' }; continue;
          case 'eov': case 'end_of_verse':
            if (currentEnv) { blocks.push(currentEnv); currentEnv = null; } continue;
          case 'section': case 'sos':
            blocks.push({ type: 'section', text: val }); continue;
          default:
            // Unknown directive — ignore silently (e.g. {new_page}, {textfont:..})
            continue;
        }
      }

      if (raw.trim() === '') {
        pushLine({ type: 'blank' });
        continue;
      }

      if (currentEnv && currentEnv.type === 'tab') {
        currentEnv.lines.push({ type: 'tabline', text: raw });
        continue;
      }

      const parsed = parseLine(raw);
      pushLine({ type: 'line', ...parsed });
    }
    if (currentEnv) blocks.push(currentEnv);
    return blocks;
  }

  function transposeChordToken(chord, steps, preferFlat) {
    if (steps === 0) return chord;
    // Match root note (A-G, optional # or b), rest is suffix. Handle slash bass chords too.
    const re = /^([A-Ga-g])([#b]?)(.*)$/;
    const applyOne = (token) => {
      const m = token.match(re);
      if (!m) return token;
      const root = m[1].toUpperCase() + m[2];
      const suffix = m[3];
      const idx = NOTE_INDEX[root];
      if (idx === undefined) return token;
      const newIdx = ((idx + steps) % 12 + 12) % 12;
      const scale = preferFlat ? FLAT_SCALE : SHARP_SCALE;
      return scale[newIdx] + suffix;
    };
    // handle slash chords e.g. D/F#
    const slashIdx = chord.indexOf('/');
    if (slashIdx > -1) {
      const left = chord.slice(0, slashIdx);
      const right = chord.slice(slashIdx + 1);
      return applyOne(left) + '/' + applyOne(right);
    }
    return applyOne(chord);
  }

  function render(container, blocks, opts) {
    opts = opts || {};
    const steps = opts.transpose || 0;
    const preferFlat = !!opts.preferFlat;
    container.innerHTML = '';

    const renderLineItem = (item, parent) => {
      if (item.type === 'blank') {
        const d = document.createElement('div');
        d.className = 'cp-line empty';
        parent.appendChild(d);
        return;
      }
      if (item.type === 'comment') {
        const d = document.createElement('div');
        d.className = 'cp-comment';
        d.textContent = item.text;
        parent.appendChild(d);
        return;
      }
      if (item.type === 'tabline') {
        // grouped by caller (tab env) — handled there
        return;
      }
      if (item.type === 'line') {
        const d = document.createElement('div');
        d.className = 'cp-line';
        if (!item.hasChords) {
          d.textContent = item.text || '\u00A0';
        } else {
          for (const seg of item.segments) {
            const span = document.createElement('span');
            span.className = 'cp-seg';
            span.textContent = seg.text || '\u00A0';
            if (seg.chord !== null && seg.chord !== undefined && seg.chord !== '') {
              const chordSpan = document.createElement('span');
              chordSpan.className = 'cp-chord';
              chordSpan.textContent = transposeChordToken(seg.chord, steps, preferFlat);
              span.appendChild(chordSpan);
            }
            d.appendChild(span);
          }
        }
        parent.appendChild(d);
        return;
      }
    };

    for (const block of blocks) {
      switch (block.type) {
        case 'title': {
          const h = document.createElement('div');
          h.className = 'cp-title';
          h.textContent = block.text;
          container.appendChild(h);
          break;
        }
        case 'subtitle': {
          const h = document.createElement('div');
          h.className = 'cp-subtitle';
          h.textContent = block.text;
          container.appendChild(h);
          break;
        }
        case 'artist': {
          const h = document.createElement('div');
          h.className = 'cp-subtitle';
          h.textContent = block.text;
          container.appendChild(h);
          break;
        }
        case 'key':
        case 'capo': {
          // collected into a meta row lazily
          let metaRow = container.querySelector('.cp-meta');
          if (!metaRow) {
            metaRow = document.createElement('div');
            metaRow.className = 'cp-meta';
            container.appendChild(metaRow);
          }
          const tag = document.createElement('span');
          const label = block.type === 'key' ? 'Key' : 'Capo';
          const value = block.type === 'key' ? transposeChordToken(block.text, steps, preferFlat) : block.text;
          tag.textContent = `${label}: ${value}`;
          metaRow.appendChild(tag);
          break;
        }
        case 'section': {
          const h = document.createElement('div');
          h.className = 'cp-section-label';
          h.textContent = block.text;
          container.appendChild(h);
          break;
        }
        case 'line':
        case 'comment':
        case 'blank':
          renderLineItem(block, container);
          break;
        case 'chorus':
        case 'bridge':
        case 'verse': {
          const wrap = document.createElement('div');
          wrap.className = block.type === 'chorus' ? 'cp-chorus' : (block.type === 'bridge' ? 'cp-bridge' : '');
          if (block.label) {
            const lbl = document.createElement('div');
            lbl.className = 'cp-section-label';
            lbl.textContent = block.label;
            container.appendChild(lbl);
          }
          for (const l of block.lines) renderLineItem(l, wrap);
          container.appendChild(wrap);
          break;
        }
        case 'tab': {
          if (block.label) {
            const lbl = document.createElement('div');
            lbl.className = 'cp-section-label';
            lbl.textContent = block.label;
            container.appendChild(lbl);
          }
          const pre = document.createElement('div');
          pre.className = 'cp-tab';
          pre.textContent = block.lines.map(l => l.text).join('\n');
          container.appendChild(pre);
          break;
        }
      }
    }
  }

  return { parse, render, extractMeta, transposeChordToken };
})();
