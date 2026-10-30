/* localmemo — ブラウザ内だけで完結する書き捨てメモ
 *
 * 設計方針
 *  - localStorage / sessionStorage / IndexedDB / Cookie は一切使わない（履歴を残さない）
 *  - ネットワーク通信は CSP で禁止（index.html の meta を参照）
 *  - スマホへ渡すときはメモ本文を圧縮して URL の # 以降（フラグメント）に載せる。
 *    フラグメントはブラウザがサーバーへ送らないため、ホスティング先にも内容は届かない
 *  - 受け取った側は本文を読み取ったあと、即座に URL から # 以降を取り除く
 *    （アドレスバーやブラウザ履歴に本文が残らないようにする）
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const memo = $('#memo');
  const stats = $('#stats');
  const dialog = $('#qr-dialog');
  const qrBox = $('#qr-box');
  const qrInfo = $('#qr-info');
  const linkDetails = $('#link-details');
  const linkUrl = $('#link-url');
  const toast = $('#toast');

  const QR_MAX_BYTES = 2953; // バージョン40・誤り訂正L・Byteモードの上限

  // 日本語を正しくバイト列にする
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  // ---------- ユーティリティ ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const utf8Bytes = (s) => enc.encode(s).length;

  function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pipeBytes(bytes, stream) {
    const blob = new Blob([bytes]);
    const resp = new Response(blob.stream().pipeThrough(stream));
    return new Uint8Array(await resp.arrayBuffer());
  }

  // メモ本文 → フラグメント文字列（"z.<base64url>" = deflate 圧縮、"t.<base64url>" = 無圧縮）
  async function encodePayload(text) {
    const raw = enc.encode(text);
    let best = 't.' + toBase64Url(raw);
    if (typeof CompressionStream === 'function') {
      try {
        const z = await pipeBytes(raw, new CompressionStream('deflate-raw'));
        const zs = 'z.' + toBase64Url(z);
        if (zs.length < best.length) best = zs;
      } catch (_) { /* 圧縮できなければ無圧縮のまま */ }
    }
    return best;
  }

  async function decodePayload(fragment) {
    const m = /^([zt])\.([A-Za-z0-9_-]+)$/.exec(fragment);
    if (!m) return null;
    const bytes = fromBase64Url(m[2]);
    if (m[1] === 't') return dec.decode(bytes);
    if (typeof DecompressionStream !== 'function') {
      throw new Error('このブラウザは圧縮データの展開に対応していません');
    }
    return dec.decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  }

  function baseUrl() {
    // file:// で開いている場合でも成り立つよう href から # 以降を落とす
    return location.href.split('#')[0];
  }

  let toastTimer = 0;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch (_) {
      showToast('コピーできませんでした（手動で選択してください）');
    }
  }

  // ---------- 文字数表示 ----------
  function updateStats() {
    const t = memo.value;
    const chars = Array.from(t).length;
    stats.textContent = chars === 0 ? '0 文字' : `${chars} 文字 / ${utf8Bytes(t)} バイト`;
  }

  // ---------- QR 生成 ----------
  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  async function renderQr() {
    const text = memo.value;
    const mode = currentMode();
    qrBox.innerHTML = '';
    qrInfo.className = 'qr-info';
    linkDetails.hidden = mode !== 'link';

    let data;
    if (mode === 'link') {
      data = baseUrl() + '#' + (await encodePayload(text));
      linkUrl.value = data;
    } else {
      data = text;
      linkUrl.value = '';
    }

    const bytes = utf8Bytes(data);
    if (bytes > QR_MAX_BYTES) {
      qrBox.innerHTML = `<div class="error">内容が長すぎて 1 枚の QR コードに収まりません。<br>
        （${bytes.toLocaleString()} バイト / 上限 ${QR_MAX_BYTES.toLocaleString()} バイト）<br>
        メモを分割するか、${mode === 'link' ? '「テキストそのまま」' : '「リンク」'}モードを試してください。</div>`;
      qrInfo.textContent = '';
      return;
    }

    try {
      const qr = qrcode(0, 'L');
      qr.addData(data, 'Byte');
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
      const n = qr.getModuleCount();
      qrInfo.textContent = `${bytes.toLocaleString()} バイト ・ ${n}×${n} セル`;
      if (n >= 125) {
        qrInfo.classList.add('warn');
        qrInfo.textContent += ' ・ 大きいので画面を明るくし、近づけて読み取ってください';
      }
    } catch (e) {
      qrBox.innerHTML = `<div class="error">QR コードを生成できませんでした: ${String(e.message || e)}</div>`;
    }
  }

  // ---------- 受信側: URL フラグメントからの復元 ----------
  async function restoreFromHash() {
    const frag = location.hash.slice(1);
    if (!frag) return;
    // 本文が履歴・アドレスバーに残らないよう、読み取ったら直ちに消す
    history.replaceState(null, '', baseUrl());
    try {
      const text = await decodePayload(frag);
      if (text == null) return;
      memo.value = text;
      updateStats();
      showToast('QR コードから受け取ったメモを開きました');
    } catch (e) {
      showToast('メモを復元できませんでした: ' + String(e.message || e));
    }
  }

  // ---------- イベント ----------
  memo.addEventListener('input', updateStats);

  $('#btn-qr').addEventListener('click', async () => {
    if (!memo.value) { showToast('メモが空です'); return; }
    dialog.showModal();
    await renderQr();
  });
  $('#btn-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', renderQr));

  $('#btn-copy').addEventListener('click', () => {
    if (!memo.value) { showToast('メモが空です'); return; }
    copyText(memo.value, 'メモをコピーしました');
  });
  $('#btn-copy-link').addEventListener('click', () => copyText(linkUrl.value, 'リンクをコピーしました'));

  $('#btn-clear').addEventListener('click', () => {
    if (!memo.value) return;
    memo.value = '';
    updateStats();
    memo.focus();
    showToast('消去しました');
  });

  // 内容が残っている状態でタブを閉じようとしたら確認する（復元手段がないため）
  window.addEventListener('beforeunload', (e) => {
    if (memo.value) { e.preventDefault(); e.returnValue = ''; }
  });

  // bfcache 等で復帰した場合も、URL に # が付いていれば取り込む
  window.addEventListener('hashchange', restoreFromHash);

  updateStats();
  restoreFromHash();
})();
