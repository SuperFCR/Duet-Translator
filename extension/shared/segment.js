/*
 * segment.js — 把 DOM 切成"翻译单元"(unit)，并负责 序列化(带占位标签) / 回填译文。
 *
 * 单元类型
 *   - element: 只含行内内容的块元素（p/li/h1/td/... 或只含文字的 div）
 *   - run:     混排容器里夹在块元素之间的一串行内节点（如 HN 评论: "文字<p>…</p>"）
 *   - mark:    不翻译、只做对齐锚点的块（pre/video/canvas）
 *
 * key = hash(规范化原文) + "." + 该哈希在本文档中的出现序号
 * 两个窗格加载同一页面、用同一算法切分，所以同一段落 key 相同 —— 这是滚动对齐的基础。
 * 状态全部放在 WeakMap / 对象里，不往原文窗格的 DOM 上写任何属性。
 */
(function (root) {
  'use strict';
  const hashText = root.PT.sync.hashText;

  const INLINE = new Set(('a abbr acronym b bdi bdo big br button cite code data del dfn em font i img input ins ' +
    'kbd label mark q rp rt ruby s samp select small span strike strong sub sup textarea time tt u var wbr ' +
    'svg math').split(' '));
  const SKIP = new Set(('script style noscript template textarea input select option svg math canvas video audio ' +
    'iframe object embed img head title meta link br hr pre code kbd samp var').split(' '));
  const LANDMARK = new Set(['pre', 'video', 'canvas']);
  // 行内元素里出现这些后代，就把它当块容器（典型：<a><div class=card>…</div></a>）
  const BLOCK_SEL = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,section,article,table,tr,td,th,blockquote,pre,dl,dt,dd,' +
    'figure,figcaption,header,footer,nav,aside,main,form,fieldset,hr,details,summary,address';
  const HAS_LETTER = /\p{L}/u;

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

  function isSkipped(el) {
    const n = el.localName;
    if (SKIP.has(n) || n.startsWith('pt-')) return true;
    if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isBlockish(el) {
    const n = el.localName;
    if (!INLINE.has(n) && !n.includes('-')) return true;
    return el.querySelector(BLOCK_SEL) !== null;
  }

  /** 作为"块"参与切分的子元素：块元素或锚点元素；被跳过的非锚点元素(script/style…)不算 */
  function isBlockChild(c) {
    if (LANDMARK.has(c.localName)) return true;
    if (isSkipped(c)) return false;
    return isBlockish(c);
  }

  function textOfNodes(nodes) {
    let s = '';
    for (const n of nodes) s += n.textContent || '';
    return s;
  }

  class Segmenter {
    constructor(doc) {
      this.doc = doc;
      this.units = [];
      this.byKey = new Map();
      this.nodeUnit = new WeakMap();   // element(单元元素) / run 中的节点 → unit
      this.occ = new Map();
      this.fixedMemo = new WeakMap();
      this.seq = 0;
    }

    /** 扫描子树，返回新发现的单元 */
    scan(rootEl) {
      const found = [];
      if (!rootEl) return found;
      if (rootEl.nodeType === 3) rootEl = rootEl.parentElement;
      if (!rootEl || rootEl.nodeType !== 1) return found;
      if (this.unitFromNode(rootEl)) return found;
      this._walk(rootEl, found);
      return found;
    }

    _walk(el, found) {
      if (isSkipped(el)) {
        if (LANDMARK.has(el.localName)) this._emit(found, 'mark', el, null, el.localName + ':' + norm(el.textContent || '').slice(0, 300) + (el.getAttribute('src') || ''));
        return;
      }
      if (this.nodeUnit.has(el)) return;
      const kids = el.childNodes;
      let hasBlock = false;
      for (const c of kids) {
        if (c.nodeType === 1 && isBlockChild(c)) { hasBlock = true; break; }
      }
      if (!hasBlock) {
        const t = el.textContent || '';
        if (HAS_LETTER.test(t)) this._emit(found, 'element', el, null, norm(t));
        return;
      }
      let run = [];
      const flush = () => {
        if (run.length) {
          const t = textOfNodes(run);
          if (HAS_LETTER.test(t)) this._emit(found, 'run', null, run, norm(t));
          run = [];
        }
      };
      for (const c of Array.from(kids)) {
        if (c.nodeType === 3) { run.push(c); continue; }
        if (c.nodeType !== 1) continue;
        if (isBlockChild(c)) { flush(); this._walk(c, found); continue; }
        if (isSkipped(c) && !INLINE.has(c.localName)) { flush(); continue; }
        run.push(c);
      }
      flush();
    }

    _emit(found, kind, el, nodes, text) {
      const h = hashText(text);
      const n = this.occ.get(h) || 0;
      this.occ.set(h, n + 1);
      const parent = el ? el : nodes[0].parentNode;
      const u = {
        id: ++this.seq,
        key: (kind === 'mark' ? 'm' : '') + h + '.' + n,
        kind, el, nodes, parent, text,
        translatable: kind !== 'mark',
        fixed: this._inFixed(el || parent),
        y: NaN, h: 0,          // 内容坐标缓存（由 pane 计算）
        tstate: '',            // 译文窗格：'' | inflight | done | error
      };
      if (el) this.nodeUnit.set(el, u); else for (const x of nodes) this.nodeUnit.set(x, u);
      this.units.push(u);
      if (!this.byKey.has(u.key)) this.byKey.set(u.key, u);
      found.push(u);
    }

    _inFixed(el) {
      const chain = [];
      let e = el, res = false;
      const view = this.doc.defaultView;
      while (e && e.nodeType === 1) {
        if (this.fixedMemo.has(e)) { res = this.fixedMemo.get(e); break; }
        chain.push(e);
        const p = view.getComputedStyle(e).position;
        if (p === 'fixed' || p === 'sticky') { res = true; break; }
        e = e.parentElement;
      }
      for (const c of chain) this.fixedMemo.set(c, res);
      return res;
    }

    /** 节点所属单元（向上查找） */
    unitFromNode(node) {
      for (let n = node; n; n = n.parentNode) {
        const u = this.nodeUnit.get(n);
        if (u) return u;
        if (n === this.doc.body) break;
      }
      return null;
    }

    isAlive(u) {
      if (u.el) return u.el.isConnected;
      return u.nodes.some((n) => n.isConnected);
    }

    /** 删除已脱离文档的单元 */
    prune() {
      const alive = [];
      for (const u of this.units) {
        if (this.isAlive(u)) alive.push(u);
        else if (this.byKey.get(u.key) === u) this.byKey.delete(u.key);
      }
      this.units = alive;
    }

    rectOf(u) {
      if (u.el) return u.el.getBoundingClientRect();
      const nodes = u.nodes.filter((n) => n.isConnected);
      if (!nodes.length) return null;
      const r = this.doc.createRange();
      r.setStartBefore(nodes[0]);
      r.setEndAfter(nodes[nodes.length - 1]);
      return r.getBoundingClientRect();
    }

    currentText(u) {
      return norm(u.el ? u.el.textContent || '' : textOfNodes(u.nodes));
    }

    /* ---------------- 序列化：行内结构 → <gN>…</gN> / <xN/> ---------------- */

    /**
     * 返回 { text, map, container, nodes }
     *   text: 发给翻译引擎的字符串；map[N-1] 是标签 N 对应的原节点
     *   container: 回填时整体替换其子节点的元素；为空则按 run 节点替换
     */
    serialize(u) {
      let container = u.el;
      let nodes = u.el ? Array.from(u.el.childNodes) : u.nodes.slice();
      // 剥掉"只包了一层"的行内外壳（<li><a>Home</a></li> → 直接翻译 a 的内容），减少标签
      for (;;) {
        const meaningful = nodes.filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.data.trim()));
        if (meaningful.length !== 1 || meaningful[0].nodeType !== 1) break;
        const only = meaningful[0];
        if (this._isAtomic(only) || isBlockish(only)) break;
        container = only;
        nodes = Array.from(only.childNodes);
      }
      const map = [], kinds = [];
      const text = norm(this._ser(nodes, map, kinds));
      return { text, map, kinds, container, nodes };
    }

    _isAtomic(el) {
      if (isSkipped(el)) return true;
      return !HAS_LETTER.test(el.textContent || '');
    }

    _ser(nodes, map, kinds) {
      let s = '';
      for (const n of nodes) {
        if (n.nodeType === 3) { s += esc(n.data.replace(/\s+/g, ' ')); continue; }
        if (n.nodeType !== 1) continue;
        map.push(n);
        const id = map.length;
        if (this._isAtomic(n)) { kinds.push('x'); s += `<x${id}/>`; continue; }
        kinds.push('g');
        s += `<g${id}>` + this._ser(Array.from(n.childNodes), map, kinds) + `</g${id}>`;
      }
      return s;
    }

    /* ---------------- 回填 ---------------- */

    /** 把译文字符串还原成 DOM 片段；标签结构不合法时返回 null */
    _build(str, map, kinds) {
      const doc = this.doc;
      const frag = doc.createDocumentFragment();
      const stack = [{ node: frag, id: 0 }];
      const used = new Set();
      const re = /<\s*(\/?)\s*([gx])\s*(\d+)\s*(\/?)\s*>/gi;
      let last = 0, m;
      const top = () => stack[stack.length - 1].node;
      const pushText = (t) => { if (t) top().appendChild(doc.createTextNode(unesc(t))); };
      while ((m = re.exec(str))) {
        pushText(str.slice(last, m.index));
        last = re.lastIndex;
        const close = m[1] === '/', kind = m[2].toLowerCase(), id = +m[3], self = m[4] === '/';
        const orig = map[id - 1];
        if (orig && kinds[id - 1] !== kind) return null;
        if (kind === 'x') {
          if (!orig) continue;
          top().appendChild(used.has(id) ? orig.cloneNode(true) : orig);
          used.add(id);
          continue;
        }
        if (close) {
          if (stack.length < 2 || stack[stack.length - 1].id !== id) return null;
          stack.pop();
          continue;
        }
        if (!orig) return null;
        let el;
        if (used.has(id)) el = orig.cloneNode(false);
        else { el = orig; el.replaceChildren(); }   // 复用原元素：保留事件监听（SPA 链接等）
        used.add(id);
        top().appendChild(el);
        if (!self) stack.push({ node: el, id });
      }
      pushText(str.slice(last));
      if (stack.length !== 1) return null;
      // 模型丢掉的原子节点（图片、代码等）补在末尾，避免内容丢失
      map.forEach((n, i) => {
        if (!used.has(i + 1) && kinds[i] === 'x' && n.localName !== 'br') frag.appendChild(n);
      });
      return frag;
    }

    /** 回填译文；返回 true 表示按结构回填，false 表示降级为纯文本 */
    apply(u, ser, translated) {
      const doc = this.doc;
      let frag = this._build(translated, ser.map, ser.kinds);
      let structured = true;
      if (!frag) {
        // 标签被模型弄乱：降级为纯文本，原子节点（图片/代码）补在末尾
        structured = false;
        frag = doc.createDocumentFragment();
        frag.appendChild(doc.createTextNode(unesc(translated.replace(/<[^>]*>/g, ''))));
        ser.map.forEach((n, i) => { if (ser.kinds[i] === 'x' && n.localName !== 'br') frag.appendChild(n); });
      }
      if (ser.container) {
        ser.container.replaceChildren(frag);
      } else {
        // run：在原位置替换一串兄弟节点，保留首尾空白
        const old = u.nodes;
        const parent = u.parent;
        const firstTxt = old[0].nodeType === 3 ? old[0].data : '';
        const lastTxt = old[old.length - 1].nodeType === 3 ? old[old.length - 1].data : '';
        let after = old[old.length - 1].nextSibling;
        while (after && old.includes(after)) after = after.nextSibling;
        if (/^\s/.test(firstTxt)) frag.insertBefore(doc.createTextNode(' '), frag.firstChild);
        if (/\s$/.test(lastTxt)) frag.appendChild(doc.createTextNode(' '));
        const fresh = Array.from(frag.childNodes);
        for (const n of old) if (n.parentNode === parent) parent.removeChild(n);
        parent.insertBefore(frag, after && after.parentNode === parent ? after : null);
        u.nodes = fresh;
        for (const n of fresh) this.nodeUnit.set(n, u);
      }
      return structured;
    }
  }

  root.PT.Segmenter = Segmenter;
  root.PT.segUtil = { norm, esc, unesc, isBlockish, isSkipped };
})(globalThis);
