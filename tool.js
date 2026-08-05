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
  // キャプチャ: 1=開始時刻(1つ目の区間の開始)、2=話者、3=本文
  var RE_DOWNLOAD =
    /^\[(\d{2}:\d{2}:\d{2})\s*->\s*\d{2}:\d{2}:\d{2}\]\s*\[\d{2}:\d{2}:\d{2}\s*->\s*\d{2}:\d{2}:\d{2}\]\s*\[([^\]]*)\]\s?(.*)$/;

  // コピペ版の本文行:
  // 00:00:02<TAB>SPEAKER_005<TAB>テキスト (通常版)
  // 00:00:00<TAB><TAB>テキスト           (リアルタイム版・話者列が空)
  // キャプチャ: 1=時刻、2=話者、3=本文
  var RE_PASTE = /^(\d{2}:\d{2}:\d{2})\t([^\t]*)\t(.*)$/;

  /**
   * 入力テキスト全体を行単位で解析し、構造化した行リストを返す。
   * ファイル全体の形式判定は行わず、1行ごとに形式を判定するため、
   * 形式が混在していても堅牢に動作する。
   * @param {string} text 入力テキスト
   * @returns {{entries: Array, warnCount: number, matchCount: number, hasSpeaker: boolean}}
   *   entries の各要素:
   *   { type: 'empty'|'header'|'utterance'|'unmatched', raw, text?, speaker?, time? }
   */
  function parseTranscript(text) {
    // 改行コードを LF に正規化(コピペ版ファイルは CRLF のため)
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var entries = [];
    var warnCount = 0;   // どの形式にも一致しなかった行数(空行・ヘッダー行は除く)
    var matchCount = 0;  // 形式に一致してタイムコード等を除去した行数
    var hasSpeaker = false; // 話者情報(空でない話者名)が1行でも存在するか

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 空行(空白のみの行を含む)は判定対象外
      if (line.trim() === '') {
        entries.push({ type: 'empty', raw: line });
        continue;
      }

      // ヘッダー行(警告対象外)
      if (RE_HEADER.test(line)) {
        entries.push({ type: 'header', raw: line });
        continue;
      }

      var m = line.match(RE_DOWNLOAD) || line.match(RE_PASTE);
      if (m) {
        var speaker = m[2].trim();
        if (speaker !== '') hasSpeaker = true;
        entries.push({ type: 'utterance', raw: line, time: m[1], speaker: speaker, text: m[3] });
        matchCount++;
        continue;
      }

      // どの形式にも一致しない行: 原文のまま保持し、警告としてカウント
      entries.push({ type: 'unmatched', raw: line });
      warnCount++;
    }

    return { entries: entries, warnCount: warnCount, matchCount: matchCount, hasSpeaker: hasSpeaker };
  }

  /**
   * 出力パターン「TC除去」: 従来通り、元の行構造を維持して1発話1行で出力する。
   * 空行・ヘッダー行・不一致行はそのままの位置に残す。
   */
  function renderPlain(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      out.push(e.type === 'utterance' ? e.text : e.raw);
    }
    return out.join('\n');
  }

  /**
   * 出力パターン「話者ごとにTC表示」:
   * 同一話者の連続発話を1段落に連結(区切りなし)し、段落の先頭に
   * 最初の発話の開始時刻を独立行として置く。話者が変わったら段落を分ける。
   * - ヘッダー行はそのまま出力(段落は分断)
   * - 不一致行はその位置で連結を分断し、原文のまま独立行として出力
   * - 空行はこのパターンでは出力から除去
   */
  function renderBySpeaker(entries) {
    var out = [];
    var curSpeaker = null; // 連結中の段落の話者。null は「段落なし」
    var buf = null;        // 連結中の本文

    // 連結中の段落を出力に確定する
    function flush() {
      if (buf !== null) out.push(buf);
      curSpeaker = null;
      buf = null;
    }

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];

      if (e.type === 'empty') continue; // 空行は除去

      if (e.type === 'utterance') {
        if (curSpeaker !== null && e.speaker === curSpeaker) {
          buf += e.text; // 同一話者の連続 → 区切りなしで直結
        } else {
          flush();
          curSpeaker = e.speaker;
          out.push(e.time); // TCを独立行として記載(話者名は書かない)
          buf = e.text;
        }
        continue;
      }

      // header / unmatched: 段落を分断して原文のまま出力
      flush();
      out.push(e.raw);
    }
    flush();
    return out.join('\n');
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
    // 全画面を覆う半透明の背景。ツール起動中は背後のページ操作をガードする。
    // inset や min() は比較的新しい CSS のため、注入先の古いブラウザでも
    // 確実に動くよう top/left/right/bottom と width/max-width で記述する
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483647;',
    '  background: rgba(15, 23, 42, 0.45);',
    '  display: flex; align-items: center; justify-content: center;',
    '  font-family: "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;',
    '  font-size: 14px; color: #1e293b;',
    '}',
    '.panel {',
    '  background: #ffffff; border-radius: 10px; width: 880px; max-width: 94vw;',
    // 高さをビューポート基準で固定し、内部を比率配分することでスクロールを発生させない
    '  height: 94vh; max-height: 94vh; display: flex; flex-direction: column;',
    '  box-shadow: 0 20px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.08); overflow: hidden;',
    '}',
    '.titlebar {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: 12px 16px; background: #0f766e; color: #fff;',
    '  cursor: move; user-select: none;',
    '}',
    '.titlebar h1 { font-size: 15px; font-weight: 600; }',
    '.btn-close-x {',
    '  background: none; border: none; color: #fff; font-size: 20px; line-height: 1;',
    '  cursor: pointer; padding: 2px 6px; border-radius: 4px;',
    '}',
    '.btn-close-x:hover { background: rgba(255,255,255,0.2); }',
    '.body {',
    '  padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;',
    // 本文領域はパネルの残り高さをすべて使い、内部要素を比率配分する。
    // min-height: 0 はフレックス子がコンテンツ高さより小さくなれるようにするための指定
    '  flex: 1 1 auto; min-height: 0; overflow-y: auto;',
    '}',
    // 固定要素(ドロップ領域・警告・ボタン行など)は縮小させない
    '.body > * { flex-shrink: 0; }',
    // 入力欄とプレビュー領域は 4:6 の比率で残り空間を分け合う
    // (高さは自動配分となるため手動リサイズは無効化)
    '#input-area { flex: 4 1 0; min-height: 60px; resize: none; }',
    '#preview-section { flex: 6 1 0; min-height: 0; display: flex; flex-direction: column; }',
    '.section-label { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px; display: block; }',
    'textarea {',
    '  width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px;',
    '  font-family: "MS Gothic", "Osaka-Mono", monospace; font-size: 12px;',
    '  resize: vertical; background: #fff; color: #1e293b;',
    '}',
    'textarea:focus { outline: 2px solid #0f766e; outline-offset: -1px; }',
    '#output-area { flex: 1 1 auto; min-height: 90px; background: #f8fafc; resize: none; }',
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
    /* 入力エリア直下の操作行(一括削除ボタン) */
    '.input-actions { display: flex; justify-content: flex-start; margin-top: -6px; }',
    '.btn-small { padding: 4px 12px; font-size: 12px; }',
    /* 出力パターン切り替え */
    '.mode-row { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }',
    '.mode-option {',
    '  display: inline-flex; align-items: center; gap: 5px; font-size: 13px;',
    '  cursor: pointer; user-select: none;',
    '}',
    '.mode-option input { accent-color: #0f766e; cursor: pointer; margin: 0; }',
    '.mode-option.disabled { color: #94a3b8; cursor: not-allowed; }',
    '.mode-option.disabled input { cursor: not-allowed; }',
    '.status { font-size: 12px; color: #64748b; min-height: 16px; }',
    '.file-note { font-size: 12px; color: #0f766e; }',
    '@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }',
    '</style>',
    '<div class="overlay" id="overlay">',
    '  <div class="panel" id="panel" role="dialog" aria-label="TC除去ツール">',
    '    <div class="titlebar" id="titlebar">',
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
    '      <div class="input-actions">',
    '        <button class="btn btn-small" id="btn-strip" disabled>TC行以外を一括削除</button>',
    '      </div>',
    '      <div class="banner-warn" id="banner-warn"></div>',
    '      <div id="preview-section">',
    '        <div class="mode-row">',
    '          <span class="section-label" style="margin-bottom:0">出力パターン</span>',
    '          <label class="mode-option"><input type="radio" name="tc-mode" id="mode-plain" value="plain" checked> TC除去</label>',
    '          <label class="mode-option" id="mode-speaker-label"><input type="radio" name="tc-mode" id="mode-speaker" value="speaker"> 話者ごとにTC表示</label>',
    '        </div>',
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

  var elModePlain = $('mode-plain');
  var elModeSpeaker = $('mode-speaker');
  var elModeSpeakerLabel = $('mode-speaker-label');

  /** 現在選択中の出力パターンを返す('plain' | 'speaker') */
  function currentMode() {
    return elModeSpeaker.checked ? 'speaker' : 'plain';
  }

  /** 「話者ごとにTC表示」の活性/非活性を切り替える */
  function setSpeakerModeEnabled(enabled) {
    elModeSpeaker.disabled = !enabled;
    elModeSpeakerLabel.classList.toggle('disabled', !enabled);
    elModeSpeakerLabel.title = enabled ? '' : '入力に話者情報(SPEAKER)が含まれていないため選択できません';
    // 非活性化時に選択中だった場合は「TC除去」へ戻す
    if (!enabled && elModeSpeaker.checked) {
      elModePlain.checked = true;
    }
  }

  var elStrip = $('btn-strip');

  /** 削除対象(不一致行+空行)の行数を数える。ヘッダー行と発話行は対象外 */
  function countRemovable(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].type === 'unmatched' || entries[i].type === 'empty') n++;
    }
    return n;
  }

  function updatePreview() {
    var text = elInput.value;
    if (text.trim() === '') {
      elOutput.value = '';
      elBanner.classList.remove('visible');
      elStatus.textContent = '';
      elCopy.disabled = true;
      elDownload.disabled = true;
      elStrip.disabled = true;
      setSpeakerModeEnabled(false);
      return;
    }

    var result = parseTranscript(text);

    // 話者情報がない入力では「話者ごとにTC表示」を選択不可にする
    setSpeakerModeEnabled(result.hasSpeaker);

    // 削除対象となる行(不一致行・空行)が存在する場合のみ一括削除ボタンを活性化
    elStrip.disabled = countRemovable(result.entries) === 0;

    elOutput.value = currentMode() === 'speaker'
      ? renderBySpeaker(result.entries)
      : renderPlain(result.entries);

    elCopy.disabled = false;
    elDownload.disabled = false;
    elStatus.textContent = result.matchCount + '行を変換しました';

    if (result.warnCount > 0) {
      elBanner.textContent = '⚠ TCが存在しない行が' + result.warnCount + '行ありました。原文のまま出力に含めています。';
      elBanner.classList.add('visible');
    } else {
      elBanner.classList.remove('visible');
    }
  }

  // 「TC行以外を一括削除」: 入力エリアから不一致行と空行を物理的に取り除く。
  // ヘッダー行(話者の総数)と発話行(TCあり)は元の形のまま残すため、
  // 削除後も通常の変換フローがそのまま機能する。
  elStrip.addEventListener('click', function () {
    var result = parseTranscript(elInput.value);
    var removed = countRemovable(result.entries);
    if (removed === 0) return;

    var kept = [];
    for (var i = 0; i < result.entries.length; i++) {
      var e = result.entries[i];
      if (e.type === 'header' || e.type === 'utterance') kept.push(e.raw);
    }
    // プログラム的な代入では input イベントは発火しないため、
    // ファイル読込由来のファイル名(sourceFilename)は維持される
    elInput.value = kept.join('\n');
    updatePreview();
    elStatus.textContent = 'TC行以外を' + removed + '行削除しました';
  });

  // 出力パターン切り替え時はプレビューを再生成
  elModePlain.addEventListener('change', updatePreview);
  elModeSpeaker.addEventListener('change', updatePreview);

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
    elStrip.disabled = true;
    // 出力パターンもデフォルトの「TC除去」に戻す
    elModePlain.checked = true;
    setSpeakerModeEnabled(false);
    elInput.focus();
  }

  $('btn-reset').addEventListener('click', resetAll);

  function hide() { host.style.display = 'none'; }
  $('btn-close').addEventListener('click', hide);
  $('btn-x').addEventListener('click', hide);

  // ツール外(背景オーバーレイ)のクリックで閉じる。
  // 背景がページ操作をガードしているため、外側クリック = 背景クリックとなり、
  // document 監視や composedPath に頼らずオーバーレイ要素で直接判定できる
  // (composedPath 非対応の古いブラウザでも確実に動く)。
  // click ではなく押下時点(pointerdown/mousedown)で判定することで、パネル内で
  // テキスト選択を開始して背景上でボタンを離した場合の誤閉じを防ぐ。
  var overlayEl = $('overlay');
  var downEvent = window.PointerEvent ? 'pointerdown' : 'mousedown';
  overlayEl.addEventListener(downEvent, function (e) {
    if (e.target === overlayEl) hide(); // パネル内からのバブリングは target が異なるため閉じない
  });

  // ================================================================
  // タイトルバードラッグによるウィンドウ移動
  // ================================================================

  var panel = $('panel');
  var titlebar = $('titlebar');
  var drag = null; // ドラッグ中の状態 { dx, dy } (ポインタとパネル左上のオフセット)

  titlebar.addEventListener('mousedown', function (e) {
    // 閉じるボタン上でのドラッグ開始は無効(クリック操作を優先)
    if (e.target.closest('#btn-x')) return;
    if (e.button !== 0) return;

    var rect = panel.getBoundingClientRect();
    // 初回ドラッグ時に flex 中央配置から fixed 座標指定へ切り替える
    // (現在の表示位置をそのまま left/top に固定してから移動を開始するため、位置が飛ばない)
    panel.style.position = 'fixed';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.margin = '0';

    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault(); // テキスト選択の開始を防ぐ
  });

  // mousemove/mouseup はパネル外へポインタが出ても追従するよう document に登録
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var w = panel.offsetWidth;
    var x = e.clientX - drag.dx;
    var y = e.clientY - drag.dy;
    // 画面外へ完全に出て操作不能になるのを防ぐクランプ
    // (横は本体の一部、縦はタイトルバーが必ず画面内に残るようにする)
    x = Math.min(Math.max(x, -w + 80), window.innerWidth - 80);
    y = Math.min(Math.max(y, 0), window.innerHeight - 40);
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });

  document.addEventListener('mouseup', function () { drag = null; });


  // オーバーレイの余白クリックでは閉じない(誤操作による入力消失を防ぐ)。
  // Esc キーでは閉じられるようにする
  shadow.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });

  // ================================================================
  // 公開・初期表示
  // ================================================================

  document.body.appendChild(host);

  // 初期状態: 入力が空のため「話者ごとにTC表示」は非活性
  setSpeakerModeEnabled(false);

  // ブックマークレット再クリック時に再表示するためのフックを登録
  window.__tcRemoverShow = function () {
    host.style.display = '';
    elInput.focus();
  };

  elInput.focus();
})();
