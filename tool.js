/*
 * TC除去ツール tool.js
 * 文字起こし結果からタイムコード・話者情報を除去し、テキストのみを抽出する。
 * ブックマークレットから任意ページに注入される想定のため、
 * Shadow DOM でスタイルを隔離し、ページ側の CSS/JS と干渉しないようにする。
 * index.html(スタンドアロンページ)からも同一ファイルを読み込んで使用する。
 */
(function () {
  'use strict';

  // 既にツールが読み込み済みの場合は再生成せず、既存インスタンスを再表示して終了
  if (window.__tcRemoverShow) {
    window.__tcRemoverShow();
    return;
  }

  // ================================================================
  // 解析ロジック
  // ================================================================

  // txtダウンロード版のヘッダー行(例: 「FC00T5179 話者の総数: 15」)の判定。
  // 仕様によりヘッダー行は出力先頭にそのまま残し、警告カウントにも含めない。
  var RE_HEADER = /話者の総数\s*[:：]/;

  // txtダウンロード版の本文行:
  // [00:00:02 -> 00:00:06] [00:00:02 -> 00:00:06] [SPEAKER_005] テキスト
  // リアルタイム版は話者が空([])になるため、[^\]]* で空も許容する。
  var RE_DOWNLOAD =
    /^\[\d{2}:\d{2}:\d{2}\s*->\s*\d{2}:\d{2}:\d{2}\]\s*\[\d{2}:\d{2}:\d{2}\s*->\s*\d{2}:\d{2}:\d{2}\]\s*\[[^\]]*\]\s?(.*)$/;

  // コピペ版の本文行:
  // 00:00:02<TAB>SPEAKER_005<TAB>テキスト (通常版)
  // 00:00:00<TAB><TAB>テキスト           (リアルタイム版・話者列が空)
  var RE_PASTE = /^\d{2}:\d{2}:\d{2}\t[^\t]*\t(.*)$/;

  /**
   * 入力テキスト全体を行単位で解析する。
   * ファイル全体の形式判定は行わず、1行ごとに形式を判定するため、
   * 形式が混在していても堅牢に動作する。
   * @param {string} text 入力テキスト
   * @returns {{output: string, warnCount: number, matchCount: number}}
   */
  function parseTranscript(text) {
    // 改行コードを LF に正規化(コピペ版ファイルは CRLF のため)
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var out = [];
    var warnCount = 0;  // どの形式にも一致しなかった行数(空行・ヘッダー行は除く)
    var matchCount = 0; // 形式に一致してタイムコード等を除去した行数

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 空行(空白のみの行を含む)は判定対象外。そのまま出力に残す
      if (line.trim() === '') {
        out.push(line);
        continue;
      }

      // ヘッダー行はそのまま残す(警告対象外)
      if (RE_HEADER.test(line)) {
        out.push(line);
        continue;
      }

      var m = line.match(RE_DOWNLOAD);
      if (m) {
        out.push(m[1]);
        matchCount++;
        continue;
      }

      m = line.match(RE_PASTE);
      if (m) {
        out.push(m[1]);
        matchCount++;
        continue;
      }

      // どの形式にも一致しない行: 原文のまま出力に残し、警告としてカウント
      out.push(line);
      warnCount++;
    }

    return { output: out.join('\n'), warnCount: warnCount, matchCount: matchCount };
  }

  /**
   * ファイルのバイト列を文字列にデコードする。
   * まず UTF-8 で読み、デコード失敗(不正バイト)を検知したら Shift_JIS で再読込する。
   * コピペ内容を Shift_JIS の txt として保存したファイルへの対応。
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function decodeBuffer(buffer) {
    try {
      // fatal: true にすると不正なバイト列で例外が発生するため、文字化け検知に使える
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      // UTF-8 として不正 → Shift_JIS として再デコード
      return new TextDecoder('shift_jis').decode(buffer);
    }
  }

  // ================================================================
  // ユーティリティ
  // ================================================================

  /** 現在のローカル時刻から MMDD_HHMMSS 形式の文字列を作る */
  function timestampString() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /** 出力ファイル名を決定する。ファイル入力時は元ファイル名ベース、貼り付け時は日時ベース */
  function buildFilename(sourceFilename) {
    if (sourceFilename) {
      // 拡張子 .txt を外して「_TC除去済.txt」を付与
      var base = sourceFilename.replace(/\.txt$/i, '');
      return base + '_TC除去済.txt';
    }
    return '文字起こし結果_TC除去済_' + timestampString() + '.txt';
  }

  // ================================================================
  // UI 構築(Shadow DOM 内に隔離)
  // ================================================================

  var host = document.createElement('div');
  host.id = 'tc-remover-host';
  // ホスト要素自体はページのレイアウトに影響を与えないよう固定配置
  host.style.cssText = 'all:initial; position:fixed; z-index:2147483647;';
  var shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = [
    '<style>',
    ':host { all: initial; }',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    '.overlay {',
    '  position: fixed; inset: 0; z-index: 2147483647;',
    '  background: rgba(15, 23, 42, 0.55);',
    '  display: flex; align-items: center; justify-content: center;',
    '  font-family: "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;',
    '  font-size: 14px; color: #1e293b;',
    '}',
    '.panel {',
    '  background: #ffffff; border-radius: 10px; width: min(880px, 94vw);',
    '  max-height: 92vh; display: flex; flex-direction: column;',
    '  box-shadow: 0 20px 60px rgba(0,0,0,0.35); overflow: hidden;',
    '}',
    '.titlebar {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: 12px 16px; background: #0f766e; color: #fff;',
    '}',
    '.titlebar h1 { font-size: 15px; font-weight: 600; }',
    '.btn-close-x {',
    '  background: none; border: none; color: #fff; font-size: 20px; line-height: 1;',
    '  cursor: pointer; padding: 2px 6px; border-radius: 4px;',
    '}',
    '.btn-close-x:hover { background: rgba(255,255,255,0.2); }',
    '.body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }',
    '.section-label { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px; display: block; }',
    'textarea {',
    '  width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px;',
    '  font-family: "MS Gothic", "Osaka-Mono", monospace; font-size: 12px;',
    '  resize: vertical; background: #fff; color: #1e293b;',
    '}',
    'textarea:focus { outline: 2px solid #0f766e; outline-offset: -1px; }',
    '#input-area { height: 140px; }',
    '#output-area { height: 180px; background: #f8fafc; }',
    '.dropzone {',
    '  border: 2px dashed #94a3b8; border-radius: 6px; padding: 10px 12px;',
    '  display: flex; align-items: center; gap: 12px; color: #64748b;',
    '  transition: background 0.15s, border-color 0.15s;',
    '}',
    '.dropzone.dragover { background: #ecfeff; border-color: #0f766e; color: #0f766e; }',
    '.btn {',
    '  border: 1px solid #cbd5e1; background: #fff; color: #1e293b;',
    '  border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;',
    '  font-family: inherit;',
    '}',
    '.btn:hover { background: #f1f5f9; }',
    '.btn:focus-visible { outline: 2px solid #0f766e; outline-offset: 1px; }',
    '.btn-primary { background: #0f766e; border-color: #0f766e; color: #fff; font-weight: 600; }',
    '.btn-primary:hover { background: #0d5f59; }',
    '.btn:disabled { opacity: 0.45; cursor: not-allowed; }',
    '.btn:disabled:hover { background: #fff; }',
    '.btn-primary:disabled:hover { background: #0f766e; }',
    '.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.spacer { flex: 1; }',
    /* コピーボタン(アイコン+テキスト) */
    '.btn-icon {',
    '  display: inline-flex; align-items: center; justify-content: center; gap: 7px;',
    '}',
    '.btn-icon svg { width: 16px; height: 16px; stroke: #1e293b; flex-shrink: 0; }',
    '.btn-icon.copied svg { stroke: #0f766e; }',
    '.btn-icon.copied { color: #0f766e; border-color: #0f766e; }',
    '.btn-icon:disabled svg { opacity: 0.45; }',
    '.banner-warn {',
    '  background: #fef3c7; border: 1px solid #f59e0b; color: #92400e;',
    '  border-radius: 6px; padding: 8px 12px; font-size: 13px; display: none;',
    '}',
    '.banner-warn.visible { display: block; }',
    '.status { font-size: 12px; color: #64748b; min-height: 16px; }',
    '.file-note { font-size: 12px; color: #0f766e; }',
    '@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }',
    '</style>',
    '<div class="overlay" id="overlay">',
    '  <div class="panel" role="dialog" aria-label="TC除去ツール">',
    '    <div class="titlebar">',
    '      <h1>TC除去ツール — 文字起こしからタイムコード・話者情報を除去</h1>',
    '      <button class="btn-close-x" id="btn-x" title="閉じる" aria-label="閉じる">×</button>',
    '    </div>',
    '    <div class="body">',
    '      <div>',
    '        <span class="section-label">入力(文字起こし結果を貼り付け、またはtxtファイルを読み込み)</span>',
    '        <div class="dropzone" id="dropzone">',
    '          <button class="btn" id="btn-file">txtファイルを選択</button>',
    '          <span>またはここにファイルをドロップ</span>',
    '          <span class="file-note" id="file-note"></span>',
    '          <input type="file" id="file-input" accept=".txt,text/plain" style="display:none">',
    '        </div>',
    '      </div>',
    '      <textarea id="input-area" placeholder="ここに文字起こし結果を貼り付け"></textarea>',
    '      <div class="banner-warn" id="banner-warn"></div>',
    '      <div>',
    '        <span class="section-label">変換結果プレビュー</span>',
    '        <textarea id="output-area" readonly placeholder="変換結果がここに表示されます"></textarea>',
    '      </div>',
    '      <div class="actions">',
    // コピーボタン: コピーアイコン(重なった四角の SVG 直接埋め込み)+テキストラベル
    '        <button class="btn btn-icon" id="btn-copy" disabled>',
    '          <svg id="icon-copy" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    '          <svg id="icon-check" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M20 6 9 17l-5-5"/></svg>',
    '          <span id="copy-label">クリップボードにコピー</span>',
    '        </button>',
    '        <button class="btn btn-primary" id="btn-download" disabled>TC除去txtダウンロード</button>',
    '        <span class="status" id="status"></span>',
    '        <span class="spacer"></span>',
    '        <button class="btn" id="btn-reset">初期化</button>',
    '        <button class="btn" id="btn-close">閉じる</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');

  // ================================================================
  // 要素参照と状態
  // ================================================================

  var $ = function (id) { return shadow.getElementById(id); };
  var elInput = $('input-area');
  var elOutput = $('output-area');
  var elBanner = $('banner-warn');
  var elStatus = $('status');
  var elFileNote = $('file-note');
  var elCopy = $('btn-copy');
  var elDownload = $('btn-download');
  var iconCopy = $('icon-copy');
  var iconCheck = $('icon-check');

  // 直近に読み込んだファイル名。貼り付けモードでは null。
  // ファイル読込後にユーザーが入力欄を手動編集した場合は貼り付けモードに戻す。
  var sourceFilename = null;
  var copyResetTimer = null;

  // ================================================================
  // 変換・表示更新
  // ================================================================

  function updatePreview() {
    var text = elInput.value;
    if (text.trim() === '') {
      elOutput.value = '';
      elBanner.classList.remove('visible');
      elStatus.textContent = '';
      elCopy.disabled = true;
      elDownload.disabled = true;
      return;
    }

    var result = parseTranscript(text);
    elOutput.value = result.output;
    elCopy.disabled = false;
    elDownload.disabled = false;
    elStatus.textContent = result.matchCount + '行を変換しました';

    if (result.warnCount > 0) {
      elBanner.textContent = '⚠ 形式に一致しない行が' + result.warnCount + '行ありました。原文のまま出力に含めています。';
      elBanner.classList.add('visible');
    } else {
      elBanner.classList.remove('visible');
    }
  }

  // ================================================================
  // ファイル読み込み
  // ================================================================

  function loadFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = decodeBuffer(reader.result);
      sourceFilename = file.name;
      elFileNote.textContent = '読込済: ' + file.name;
      // プログラム的な代入では input イベントは発火しないため、手動編集検知と衝突しない
      elInput.value = text;
      updatePreview();
    };
    reader.onerror = function () {
      elStatus.textContent = 'ファイルの読み込みに失敗しました';
    };
    reader.readAsArrayBuffer(file);
  }

  $('btn-file').addEventListener('click', function () { $('file-input').click(); });
  $('file-input').addEventListener('change', function (e) {
    loadFile(e.target.files[0]);
    e.target.value = ''; // 同じファイルを再選択できるようにリセット
  });

  var dropzone = $('dropzone');
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      loadFile(e.dataTransfer.files[0]);
    }
  });

  // 入力欄の手動編集(貼り付け含む)を検知したら貼り付けモードに切り替え
  elInput.addEventListener('input', function () {
    sourceFilename = null;
    elFileNote.textContent = '';
    updatePreview();
  });

  // ================================================================
  // コピー・ダウンロード・初期化・閉じる
  // ================================================================

  var elCopyLabel = $('copy-label');

  function showCopied() {
    // コピー成功のフィードバック: アイコンをチェックマークに、文言を「コピーしました」に一時変更
    iconCopy.style.display = 'none';
    iconCheck.style.display = '';
    elCopy.classList.add('copied');
    elCopyLabel.textContent = 'コピーしました';
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(function () {
      iconCopy.style.display = '';
      iconCheck.style.display = 'none';
      elCopy.classList.remove('copied');
      elCopyLabel.textContent = 'クリップボードにコピー';
    }, 1600);
  }

  elCopy.addEventListener('click', function () {
    var text = elOutput.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  });

  // Clipboard API が使えない環境向けのフォールバック(選択+execCommand)
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed; opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showCopied();
    } catch (e) {
      elStatus.textContent = 'コピーに失敗しました。プレビューを手動で選択してコピーしてください';
    }
    document.body.removeChild(ta);
  }

  elDownload.addEventListener('click', function () {
    // ダウンロードは BOM付きUTF-8、改行は Windows 互換の CRLF で出力
    var content = '\uFEFF' + elOutput.value.replace(/\n/g, '\r\n');
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = buildFilename(sourceFilename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    elStatus.textContent = 'ダウンロードしました: ' + a.download;
  });

  function resetAll() {
    elInput.value = '';
    elOutput.value = '';
    elBanner.classList.remove('visible');
    elStatus.textContent = '';
    elFileNote.textContent = '';
    sourceFilename = null;
    elCopy.disabled = true;
    elDownload.disabled = true;
    elInput.focus();
  }

  $('btn-reset').addEventListener('click', resetAll);

  function hide() { host.style.display = 'none'; }
  $('btn-close').addEventListener('click', hide);
  $('btn-x').addEventListener('click', hide);

  // オーバーレイの余白クリックでは閉じない(誤操作による入力消失を防ぐ)。
  // Esc キーでは閉じられるようにする
  shadow.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });

  // ================================================================
  // 公開・初期表示
  // ================================================================

  document.body.appendChild(host);

  // ブックマークレット再クリック時に再表示するためのフックを登録
  window.__tcRemoverShow = function () {
    host.style.display = '';
    elInput.focus();
  };

  elInput.focus();
})();
