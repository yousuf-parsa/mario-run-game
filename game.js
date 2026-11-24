'use strict';
/* =====================================================================
   PIXEL DASH — a retro auto-runner platformer
   Vanilla ES6+ · Canvas 2D · Web Audio · zero external assets
   ===================================================================== */
(() => {
  // ===================================================================
  //  CONSTANTS & TUNING
  // ===================================================================
  const TILE = 16;
  const ROWS = 15;
  const VIEW_H = ROWS * TILE; // 240 logical pixels tall
  const STEP = 1 / 120;       // fixed physics step (identical on 60/120/144 Hz)
  const MAX_DT = 0.1;         // clamp for long frames / tab switches
  const MAX_STEPS = 14;

  const RUN_SPEED = 92;
  const STAR_MULT = 1.35;
  const SPIN_MULT = 1.3;
  const G_FALL = 1400;
  const G_HOLD = 820;
  const G_RELEASE = 2600;
  const G_SPIN = 260;
  const MAX_FALL = 430;
  const JUMP_V = 340;
  const BIG_JUMP_V = 350;
  const VAULT_V = 285;
  const ENEMY_VAULT_V = 305;
  const HIGH_VAULT_V = 420;
  const KICK_V = 340;
  const STOMP_V = 280;
  const SPIN_LIFT = 85;
  const HOLD_MAX = 0.3;
  const WALL_SLIDE_MAX = 65;
  const SPIN_TIME = 0.42;
  const VAULT_WINDOW = 0.32;
  const ENEMY_SPEED = 30;
  const STAR_TIME = 10;
  const MAX_PARTICLES = 260;

  // Tile ids
  const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_QCOIN = 3, T_QBERRY = 4, T_QSTAR = 5,
    T_USED = 6, T_PTL = 7, T_PTR = 8, T_PBL = 9, T_PBR = 10, T_HARD = 11,
    T_LAVA_TOP = 12, T_LAVA = 13, T_COIN = 14, T_MBRICK = 15;
  const SOLID = new Uint8Array(32);
  [T_GROUND, T_BRICK, T_QCOIN, T_QBERRY, T_QSTAR, T_USED, T_PTL, T_PTR, T_PBL, T_PBR, T_HARD, T_MBRICK]
    .forEach(id => { SOLID[id] = 1; });
  const LETHAL = new Uint8Array(32);
  LETHAL[T_LAVA_TOP] = 1;
  LETHAL[T_LAVA] = 1;

  const THEME_NAMES = ['Grasslands', 'Crystal Cavern', 'Ember Fortress'];
  const TRACK_FOR_THEME = ['over', 'cave', 'castle'];
  const PAR_TIME = [62, 70, 72];

  // ===================================================================
  //  SMALL UTILITIES
  // ===================================================================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const chance = p => Math.random() < p;
  const pad = (n, len) => String(Math.max(0, Math.floor(n))).padStart(len, '0');
  const midi = m => 440 * 2 ** ((m - 69) / 12);

  function compactDead(arr) {
    let j = 0;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!o.dead) arr[j++] = o;
    }
    arr.length = j;
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------- persistent storage (always guarded + schema-validated) ----------
  // Anything read back from localStorage is treated as untrusted input: size-capped,
  // parsed inside try/catch, validated, and only known fields are copied out.
  const STORE_MAX_CHARS = 2048;
  const Store = {
    load(key, fallback, isValid) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw.length > STORE_MAX_CHARS) return fallback;
        const v = JSON.parse(raw);
        return isValid(v) ? v : fallback;
      } catch {
        return fallback; // storage blocked, security error or corrupt JSON
      }
    },
    save(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable (private mode / quota / blocked) — ignore */
      }
    }
  };
  const isCount = v => Number.isSafeInteger(v) && v >= 0;
  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  let highScore = Store.load('pixeldash.high', 0, isCount);
  let bestDistance = Store.load('pixeldash.endless', 0, isCount);
  const savedPrefs = Store.load('pixeldash.prefs', {}, isPlainObject);
  const prefs = {
    music: savedPrefs.music !== false,
    sound: savedPrefs.sound !== false,
    crt: savedPrefs.crt === true
  };

  // ===================================================================
  //  PIXEL ART — matrices baked to offscreen canvases at startup
  // ===================================================================
  /** Feature-test OffscreenCanvas 2D (iOS Safari 16.4-16.7 exposed OffscreenCanvas without 2D context). */
  const CAN_OFFSCREEN_2D = (() => {
    if (typeof OffscreenCanvas !== 'function') return false;
    try {
      return !!new OffscreenCanvas(1, 1).getContext('2d');
    } catch {
      return false;
    }
  })();

  /** Sprite surfaces live off-DOM (OffscreenCanvas when 2D is supported). */
  function makeCanvas(w, h) {
    if (CAN_OFFSCREEN_2D) return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function hexToRgb(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    const r = Math.round(lerp(A[0], B[0], t)), g = Math.round(lerp(A[1], B[1], t)), bl = Math.round(lerp(A[2], B[2], t));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }

  /** Bake a pixel matrix (array of strings, one char per pixel) with a palette. */
  function bake(rows, pal, w = 16, h = rows.length) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    const cache = {};
    for (let y = 0; y < h; y++) {
      const row = rows[y] || '';
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        if (!ch || ch === '.') continue;
        const col = pal[ch];
        if (!col) continue;
        const rgb = cache[ch] || (cache[ch] = hexToRgb(col));
        const i = (y * w + x) * 4;
        d[i] = rgb[0];
        d[i + 1] = rgb[1];
        d[i + 2] = rgb[2];
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function flipH(src) {
    const c = makeCanvas(src.width, src.height);
    const g = c.getContext('2d');
    g.translate(src.width, 0);
    g.scale(-1, 1);
    g.drawImage(src, 0, 0);
    return c;
  }

  // ---------- Hero: "Pip" (teal cap, orange jacket) ----------
  const HERO_HEAD = [
    '.....KKKKK......',
    '....KHHHHHKK....',
    '...KHHHWHHHHK...',
    '...KhhhhhhhhhKK.',
    '...KKSSSSKSKKK..',
    '..KsKSSSSKSSK...',
    '...KSSSSSSSSSK..',
    '....KKSSSSKKK...'
  ];
  const HERO_HEAD_DEAD = [
    '.....KKKKKK.....',
    '....KHHHHHHK....',
    '...KHHHWWHHHK...',
    '...KhhhhhhhhK...',
    '...KSKSSSSKSK...',
    '..KsSSKSSKSSsK..',
    '...KSSSKKSSSK...',
    '....KKSSSSKK....'
  ];
  const SMALL_BODY = {
    stand: [
      '....KJJJJJK.....',
      '...KJJjJJJJK....',
      '...KSJjJJJSK....',
      '....KJJJJJK.....',
      '....KPPPPPK.....',
      '....KPPKPPK.....',
      '...KBBK.KBBK....',
      '...KKKK.KKKK....'
    ],
    run1: [
      '....KJJJJJK.....',
      '...KJJjJJJSK....',
      '..KSJJjJJJK.....',
      '....KJJJJJK.....',
      '...KPPPPPPPK....',
      '..KPPK...KPPK...',
      '.KBBK.....KBBK..',
      '.KKK.......KKK..'
    ],
    run2: [
      '....KJJJJJK.....',
      '...KJJjJJJK.....',
      '...KJJjSJJK.....',
      '....KJJJJJK.....',
      '....KPPPPPK.....',
      '.....KPPPK......',
      '.....KBBBK......',
      '.....KKKKK......'
    ],
    run3: [
      '....KJJJJJK.....',
      '...KSJjJJJJK....',
      '....KJjJJJJSK...',
      '....KJJJJJK.....',
      '....KPPPPPPK....',
      '...KPPK.KPPK....',
      '..KBBK...KBBK...',
      '..KKK.....KKK...'
    ],
    jump: [
      '....KJJJJJKSK...',
      '...KJJjJJJJK....',
      '..KSJJjJJJK.....',
      '....KJJJJJK.....',
      '....KPPPPPPK....',
      '...KPPKKPPBK....',
      '...KBBK.KKK.....',
      '...KKK..........'
    ],
    skid: [
      '...KJJJJJK......',
      '..KJJjJJJJK.....',
      '.KSJJjJJJJSK....',
      '...KJJJJJK......',
      '...KPPPPPPK.....',
      '...KPPK.KPPK....',
      '..KBBK....KBBK..',
      '..KKK.....KKKK..'
    ],
    wall: [
      '....KJJJJJKSK...',
      '...KJJjJJJJK....',
      '...KJJjJJJK.....',
      '....KJJJJJK.....',
      '....KPPPPPK.....',
      '....KPPKPPK.....',
      '...KBBK.KBBK....',
      '...KKK...KKK....'
    ],
    dead: [
      '.KS.KJJJJJK.SK..',
      '..KJJJjJJJJJK...',
      '...KJJjJJJJK....',
      '....KJJJJJK.....',
      '....KPPPPPK.....',
      '....KPPKPPK.....',
      '...KBBK.KBBK....',
      '...KKKK.KKKK....'
    ]
  };
  const BIG_TORSO = [
    '....KJJJJJJK....',
    '...KYYYYYYYYK...',
    '...KJJJJjJJJK...',
    '..KJJJJJjJJJJK..',
    '..KJJJJJjJJJJK..',
    '..KJJKJJjJJKJK..',
    '..KJJKJJjJJKJK..',
    '..KJJKJJjJJKJK..',
    '..KSSKJJjJJKSK..',
    '..KSSKJJjJJKSK..',
    '...KKKJJjJJKK...',
    '....KJJJJJJK....'
  ];
  const BIG_TORSO_UP = [
    '....KJJJJJJKKSK.',
    '...KYYYYYYYYKSK.',
    '...KJJJJjJJJKJK.',
    '..KJJJJJjJJJJJK.',
    '..KJJJJJjJJJJK..',
    '..KJJKJJjJJJK...',
    '..KJJKJJjJJJK...',
    '..KJJKJJjJJJK...',
    '..KSSKJJjJJJK...',
    '..KSSKJJjJJJK...',
    '...KKKJJjJJK....',
    '....KJJJJJJK....'
  ];
  const BIG_LEGS = {
    stand: [
      '....KPPPPPPK....',
      '....KPPPPPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '...KBBBKKBBBK...',
      '...KBBBKKBBBK...',
      '..KBBBBKKBBBBK..',
      '..KKKKKKKKKKKK..'
    ],
    run1: [
      '....KPPPPPPK....',
      '....KPPPPPPK....',
      '...KPPPPPPPPK...',
      '...KPPKKKKPPK...',
      '..KPPK....KPPK..',
      '..KPPK....KPPK..',
      '.KPPK......KPPK.',
      '.KPPK......KPPK.',
      'KBBBK.......KBBK',
      'KBBBK......KBBBK',
      'KBBBBK.....KBBBK',
      'KKKKKK.....KKKKK'
    ],
    run2: [
      '....KPPPPPPK....',
      '....KPPPPPPK....',
      '....KPPPPPPK....',
      '.....KPPPPK.....',
      '.....KPPPPK.....',
      '.....KPPPPK.....',
      '.....KPPPPK.....',
      '.....KPPPPK.....',
      '....KBBBBBBK....',
      '....KBBBBBBK....',
      '....KBBBBBBBK...',
      '....KKKKKKKKK...'
    ],
    run3: [
      '....KPPPPPPK....',
      '....KPPPPPPK....',
      '...KPPPKKPPPK...',
      '...KPPK..KPPK...',
      '..KPPK....KPPK..',
      '..KPPK.....KPK..',
      '..KPPK.....KPK..',
      '.KBBK......KPK..',
      '.KBBBK....KBBBK.',
      '.KBBBK....KBBBK.',
      '.KBBBBK...KBBBBK',
      '.KKKKKK...KKKKKK'
    ],
    jump: [
      '....KPPPPPPK....',
      '....KPPPPPPPK...',
      '...KPPPPKKPPPK..',
      '...KPPPK..KPPK..',
      '...KPPK...KPPK..',
      '...KPPK..KBBBK..',
      '..KBBBK..KBBBBK.',
      '..KBBBBK.KKKKKK.',
      '..KKKKKK........',
      '................',
      '................',
      '................'
    ],
    skid: [
      '...KPPPPPPK.....',
      '...KPPPPPPPK....',
      '..KPPPKKKPPK....',
      '..KPPK...KPPK...',
      '.KPPK.....KPPK..',
      '.KPPK.....KPPK..',
      'KPPK.......KPPK.',
      'KPPK.......KPPK.',
      'KBBBK......KBBBK',
      'KBBBK......KBBBK',
      'KBBBBK.....KBBBB',
      'KKKKKK.....KKKKK'
    ]
  };
  BIG_LEGS.wall = BIG_LEGS.stand;

  const HERO_PALS = [
    { K: '#1b1230', H: '#1fb5a8', h: '#0e7a70', W: '#ffffff', S: '#f7c48f', s: '#d58a5c', J: '#ff7a2a', j: '#c4470f', Y: '#ffd23f', P: '#2f3f9e', B: '#6b3a1e' },
    { K: '#1b1230', H: '#ff4fa3', h: '#b02a6e', W: '#ffffff', S: '#ffe0b8', s: '#e0a070', J: '#ffe14d', j: '#d0a000', Y: '#ffffff', P: '#ff4fa3', B: '#7a2a5a' },
    { K: '#0a1a30', H: '#7cff6b', h: '#2aa03a', W: '#ffffff', S: '#ffe0b8', s: '#e0a070', J: '#33d1ff', j: '#1078b0', Y: '#7cff6b', P: '#7cff6b', B: '#1a5a2a' },
    { K: '#300a0a', H: '#ffffff', h: '#b0b0c0', W: '#ff4040', S: '#ffe0b8', s: '#e0a070', J: '#ff4040', j: '#a01818', Y: '#ffb000', P: '#ffb000', B: '#7a3a00' }
  ];

  // ---------- Enemy: "Gloomp" slime ----------
  const GLOOMP_TOP = [
    '................',
    '......KKKK......',
    '....KKVVVVKK....',
    '...KVVVVVVVVK...',
    '..KVVVVVVVVVVK..',
    '..KVWWKVVKWWVK..',
    '..KVWKKVVKKWVK..',
    '.KVVVVVVVVVVVVK.',
    '.KVVVVVVVVVVVVK.',
    '.KVVvKKKKKKvVVK.',
    '.KVVVVVVVVVVVVK.',
    '..KvvvvvvvvvvK..',
    '...KKKKKKKKKK...'
  ];
  const GLOOMP_F0 = GLOOMP_TOP.concat(['...KOOK..KOOK...', '...KKKK..KKKK...', '................']);
  const GLOOMP_F1 = GLOOMP_TOP.concat(['..KOOK....KOOK..', '..KKKK....KKKK..', '................']);
  const GLOOMP_SQUISH = [
    '................', '................', '................', '................', '................',
    '................', '................', '................', '................', '................',
    '....KKKKKKKK....',
    '..KKVVVVVVVVKK..',
    '.KVVWKVVVVKWVVK.',
    'KVVVVVVVVVVVVVVK',
    'KvvvvvvvvvvvvvvK',
    '.KKKKKKKKKKKKKK.'
  ];

  // ---------- Tiles ----------
  const GROUND_TOP = [
    'GGGGGGGGGGGGGGGG',
    'GgGGGGgGGGGGgGGG',
    'gggGggggGgggggGg',
    'DgDDgDDDgDDgDDgD',
    'DDDDDDdDDDDDDDDD',
    'DDdDDDDDDDDdDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDDdDDDdDDDDdD',
    'DDDDDDDDDDDDDDDD',
    'DdDDDDDDDDDDDDDD',
    'DDDDDDDDdDDDDDDD',
    'DDDDdDDDDDDDdDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDDDDdDDDDDDDD',
    'DDdDDDDDDDDDDdDD',
    'DDDDDDDDDDDDDDDD'
  ];
  const GROUND_FILL = [
    'DDDDDDDDDDDDDDDD',
    'DDdDDDDDDDDDdDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDDDdDDDDDDDDD',
    'DdDDDDDDDDdDDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDDDDDDDDDDDdD',
    'DDDdDDDDDDDDDDDD',
    'DDDDDDDDdDDDDDDD',
    'DDDDDDDDDDDDDDDD',
    'DdDDDDDDDDDDdDDD',
    'DDDDDDdDDDDDDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDdDDDDDDDDDDD',
    'DDDDDDDDDDdDDDDD',
    'DDDDDDDDDDDDDDDD'
  ];
  const BRICK = [
    'LLLLLLLLLLLLLLLm',
    'RRRRRRRmRRRRRRRm',
    'RRRRRRRmRRRRRRRm',
    'rrrrrrrmrrrrrrrm',
    'mmmmmmmmmmmmmmmm',
    'LLLmLLLLLLLmLLLL',
    'RRRmRRRRRRRmRRRR',
    'RRRmRRRRRRRmRRRR',
    'rrrmrrrrrrrmrrrr',
    'mmmmmmmmmmmmmmmm',
    'LLLLLLLmLLLLLLLm',
    'RRRRRRRmRRRRRRRm',
    'rrrrrrrmrrrrrrrm',
    'mmmmmmmmmmmmmmmm',
    'LLLmLLLLLLLmLLLL',
    'rrrmrrrrrrrmrrrr'
  ];
  const HARD = [
    'LLLLLLLLLLLLLLLD',
    'LLLLLLLLLLLLLLdD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LLHHHHHHHHHHHddD',
    'LddddddddddddddD',
    'dddddddddddddddD',
    'DDDDDDDDDDDDDDDD'
  ];
  const QBLOCK = [
    '.KKKKKKKKKKKKKK.',
    'KQQQQQQQQQQQQQQK',
    'KQkQQQQQQQQQQkQK',
    'KQQQQWWWWWQQQQQK',
    'KQQQWWqqqWWQQQQK',
    'KQQQWWqQQWWqQQQK',
    'KQQQQqqQQWWqQQQK',
    'KQQQQQQQWWqqQQQK',
    'KQQQQQQWWqqQQQQK',
    'KQQQQQQWWqQQQQQK',
    'KQQQQQQQqqQQQQQK',
    'KQQQQQQWWQQQQQQK',
    'KQQQQQQWWqQQQQQK',
    'KQkQQQQQqqQQQkQK',
    'KqqqqqqqqqqqqqqK',
    '.KKKKKKKKKKKKKK.'
  ];
  const USED_BLOCK = [
    '.KKKKKKKKKKKKKK.',
    'KUUUUUUUUUUUUUuK',
    'KUkUUUUUUUUUUkuK'
  ].concat(new Array(10).fill('KUUUUUUUUUUUUUuK')).concat([
    'KUkUUUUUUUUUUkuK',
    'KuuuuuuuuuuuuuuK',
    '.KKKKKKKKKKKKKK.'
  ]);
  const PIPE_TL = ['KKKKKKKKKKKKKKKK'].concat(new Array(13).fill('KWWLLGGGGGGGGGGG'))
    .concat(['KKKKKKKKKKKKKKKK', '..KWLLGGGGGGGGGG']);
  const PIPE_TR = ['KKKKKKKKKKKKKKKK'].concat(new Array(13).fill('GGGGGGGggggggggK'))
    .concat(['KKKKKKKKKKKKKKKK', 'GGGGGGgggggggK..']);
  const PIPE_BL = new Array(16).fill('..KWLLGGGGGGGGGG');
  const PIPE_BR = new Array(16).fill('GGGGGGgggggggK..');
  const LAVA_TOP = [
    '................',
    '................',
    '..YY.......YY...',
    '.YOOY.....YOOY..',
    'YOOOOYYYYYOOOOYY',
    'OOOOOOOOOOOOOOOO',
    'OOROOOOOOOROOOOO',
    'OOOOOOROOOOOOOOO',
    'ORRROOOOOORRROOO',
    'RRRRROOOORRRRROO',
    'RRRRRRRRRRRRRRRR',
    'RRRrRRRRRRRrRRRR',
    'RRRRRRRrRRRRRRRR',
    'RrRRRRRRRRRRRrRR',
    'RRRRRRRRRRRRRRRR',
    'RRRRRrRRRRRRRRRR'
  ];
  const rotRow = (s, n) => s.slice(n) + s.slice(0, n);
  const LAVA_TOP_2 = LAVA_TOP.map(r => rotRow(r, 8));
  const LAVA_BODY = [
    'RRRRRrRRRRRRRRRR', 'RRRRRRRRRRRrRRRR', 'RrRRRRRRRRRRRRRR', 'RRRRRRRRrRRRRRRR',
    'RRRRRRRRRRRRRRrR', 'RRRrRRRRRRRRRRRR', 'RRRRRRRRRRrRRRRR', 'RRRRRRrRRRRRRRRR',
    'RrRRRRRRRRRRRRRR', 'RRRRRRRRRRRRRrRR', 'RRRRrRRRRRRRRRRR', 'RRRRRRRRRrRRRRRR',
    'RRRRRRRRRRRRRRRR', 'RRrRRRRRRRRRrRRR', 'RRRRRRRrRRRRRRRR', 'RRRRRRRRRRRRRRRR'
  ];
  const COIN_F0 = [
    '................',
    '......KKKK......',
    '.....KYYYYK.....',
    '....KYWYYYYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYWYYOYK....',
    '....KYYYYOYK....',
    '.....KYYYYK.....',
    '......KKKK......',
    '................',
    '................'
  ];
  const COIN_F1 = ['................', '.......KK.......', '......KYYK......']
    .concat(new Array(9).fill('......KWYK......'))
    .concat(['......KYYK......', '.......KK.......', '................', '................']);
  const COIN_F2 = ['................', '.......KK.......']
    .concat(new Array(11).fill('.......YO.......'))
    .concat(['.......KK.......', '................', '................']);
  const BERRY = [
    '................',
    '.......gK.......',
    '....KKggGGKK....',
    '...KGGGgGGGGK...',
    '....KKRRRRKK....',
    '...KRRWWRRRRK...',
    '..KRRWWRRRRRRK..',
    '..KRRWRRRRRRRK..',
    '..KRRRRRRRRRRK..',
    '..KRRRRRRRRrRK..',
    '..KRRRRRRRRrRK..',
    '...KRRRRRRrrK...',
    '...KrRRRRrrrK...',
    '....KKrrrrKK....',
    '......KKKK......',
    '................'
  ];
  const STAR = [
    '.......KK.......',
    '......KYYK......',
    '......KYYK......',
    '.....KYWYYK.....',
    'KKKKKKYWYYKKKKKK',
    'KYYYYYWYYYYYYYOK',
    '.KYYYYYYYYYYYOK.',
    '..KYYYYYYYYYOK..',
    '...KYYYYYYYOK...',
    '....KYYYYYYK....',
    '...KYYYYYYYOK...',
    '...KYYYKKYYYK...',
    '..KYYYK..KYOOK..',
    '..KYYK....KYOK..',
    '.KYK.......KYK..',
    '.KK.........KK..'
  ];
  const FIREBALL = [
    '..YYYY..',
    '.YOOOOY.',
    'YOOWWOOY',
    'YOWWWWOY',
    'YOWWWWOY',
    'YOOWWOOY',
    '.YOOOOY.',
    '..YYYY..'
  ];
  const FLAG = [
    'KKKKKKKKKKKKKKKK',
    '.KWWWWWWWWWWWWWK',
    '..KWWWWWWWWWWWWK',
    '...KWWWGGWWWWWWK',
    '....KWWGGGWWWWWK',
    '.....KWWGGGWWWWK',
    '......KWWGGWWWWK',
    '.......KWWWWWWWK',
    '........KWWWWWWK',
    '.........KWWWWWK',
    '..........KWWWWK',
    '...........KWWWK',
    '............KWWK',
    '.............KWK',
    '..............KK',
    '................'
  ];
  const BALL = ['..KKKK..', '.KGGGGK.', 'KGWGGGgK', 'KGGGGGgK', 'KGGGGggK', 'KgGGggK.', '.KgggK..', '..KKK...'];

  // ---------- tiny 3x5 pixel font for score popups ----------
  const FONT = {
    '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
    'U': ['101', '101', '101', '101', '111'], 'P': ['111', '101', '111', '100', '100'],
    '+': ['000', '010', '111', '010', '000'], 'x': ['000', '101', '010', '101', '000'],
    'B': ['110', '101', '110', '101', '110'], 'E': ['111', '100', '110', '100', '111'],
    'S': ['111', '100', '111', '001', '111'], 'T': ['111', '010', '010', '010', '010']
  };

  // ---------- Theme palettes ----------
  const THEMES = [
    { // Grasslands
      ground: { G: '#62d64e', g: '#2f9a35', D: '#c9803a', d: '#93531f', K: '#4a2a10' },
      brick: { L: '#ffb48a', R: '#d0602e', r: '#a24418', m: '#3f1a08' },
      hard: { L: '#ffd9a8', H: '#d08a4a', d: '#8a4a1a', D: '#3f1a08' },
      pipe: { K: '#0b3016', W: '#e0ffd8', L: '#8ce872', G: '#36b043', g: '#1a7a2a' },
      used: { K: '#3f1a08', U: '#b06a3a', u: '#7a4220', k: '#3f1a08' },
      enemy: { K: '#1a0d2e', V: '#a35be8', v: '#6a2bb0', W: '#ffffff', O: '#ff9a3a' },
      castle: { base: '#d0602e', dark: '#a24418', mortar: '#5a2a10', light: '#ffb48a', door: '#1a0a04' },
      pole: '#9be8a0'
    },
    { // Crystal Cavern
      ground: { G: '#7aa8e8', g: '#3f6bb0', D: '#3a3f74', d: '#262a52', K: '#11132e' },
      brick: { L: '#9cc4ff', R: '#3f72c8', r: '#2a4f94', m: '#0e1530' },
      hard: { L: '#b8d4ff', H: '#5a7ac8', d: '#2f427a', D: '#10142e' },
      pipe: { K: '#0a2030', W: '#e0f8ff', L: '#7ad8f0', G: '#2a9ac0', g: '#16607e' },
      used: { K: '#1a1030', U: '#8a6ab0', u: '#5a3a80', k: '#1a1030' },
      enemy: { K: '#06202e', V: '#3fc4d8', v: '#1f7a9a', W: '#ffffff', O: '#ffd23f' },
      castle: { base: '#3f72c8', dark: '#2a4f94', mortar: '#0e1530', light: '#9cc4ff', door: '#05060f' },
      pole: '#bfe0ff'
    },
    { // Ember Fortress
      ground: { G: '#a9a3b3', g: '#6f6880', D: '#5d5668', d: '#433d4e', K: '#1d1824' },
      brick: { L: '#c8c0cc', R: '#8a8294', r: '#665f70', m: '#25202c' },
      hard: { L: '#dcd6e2', H: '#9a92a6', d: '#5c5568', D: '#211c28' },
      pipe: { K: '#2a1010', W: '#ffe0d0', L: '#e08a6a', G: '#a8483a', g: '#6a2620' },
      used: { K: '#211c28', U: '#7a6a5a', u: '#4a3e34', k: '#211c28' },
      enemy: { K: '#2a0808', V: '#d84a4a', v: '#8a1f2a', W: '#ffe9c8', O: '#8a8a9a' },
      castle: { base: '#8a8294', dark: '#665f70', mortar: '#25202c', light: '#c8c0cc', door: '#0a0406' },
      pole: '#ffcf9a'
    }
  ];
  const Q_PALS = [
    { K: '#5a2e06', Q: '#ffcf3f', q: '#c97a12', k: '#8a4c0c', W: '#fffbe8' },
    { K: '#5a2e06', Q: '#f2b42a', q: '#b86a10', k: '#8a4c0c', W: '#fff2c8' },
    { K: '#5a2e06', Q: '#e09a1c', q: '#a05a0c', k: '#7a400a', W: '#ffe6a8' }
  ];

  const SPR = {};

  // ---------- procedural pixel helpers for backgrounds ----------
  function blob(w, h, circles, colors) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const inside = (x, y) => {
      for (let i = 0; i < circles.length; i++) {
        const k = circles[i];
        const dx = x - k[0], dy = y - k[1];
        if (dx * dx + dy * dy <= k[2] * k[2]) return true;
      }
      return false;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside(x, y)) continue;
        let col = colors.fill;
        if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || (y < h - 1 && !inside(x, y + 1))) col = colors.outline;
        else if (colors.shade && !inside(x + 3, y + 3) && y < h - 1) col = colors.shade;
        else if (colors.light && !inside(x - 3, y - 3)) col = colors.light;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    return c;
  }

  function skyStrip(top, bottom, bands) {
    const c = makeCanvas(1, VIEW_H);
    const g = c.getContext('2d');
    const bh = VIEW_H / bands;
    for (let i = 0; i < bands; i++) {
      g.fillStyle = mixHex(top, bottom, i / (bands - 1));
      g.fillRect(0, Math.floor(i * bh), 1, Math.ceil(bh) + 1);
    }
    return c;
  }

  function bakeBackgrounds() {
    const BG = [];

    // ---- Grasslands ----
    {
      const sky = skyStrip('#3f9cff', '#c4ecff', 14);
      // far mountains
      const far = makeCanvas(320, VIEW_H);
      let g = far.getContext('2d');
      for (let x = 0; x < 320; x++) {
        const t1 = Math.abs(((x + 40) % 160) - 80);
        const t2 = Math.abs(((x + 110) % 106) - 53);
        let top = Math.min(118 + t1 * 0.95, 138 + t2 * 0.9);
        top = Math.floor(top / 2) * 2;
        g.fillStyle = '#8ec6e6';
        g.fillRect(x, top, 1, VIEW_H - top);
        g.fillStyle = '#a9daf2';
        g.fillRect(x, top, 1, 2);
        if (top < 132) {
          g.fillStyle = '#f4fbff';
          g.fillRect(x, top, 1, Math.max(2, 132 - top) * 0.5 + 2);
        }
      }
      // clouds
      const clouds = makeCanvas(384, 110);
      g = clouds.getContext('2d');
      const cloudCol = { fill: '#ffffff', outline: '#5a8ac8', shade: '#cfe6ff' };
      g.drawImage(blob(48, 24, [[12, 16, 9], [24, 11, 11], [36, 16, 9], [24, 18, 8]], cloudCol), 16, 18);
      g.drawImage(blob(64, 26, [[12, 18, 8], [26, 12, 11], [40, 10, 10], [52, 18, 8], [32, 19, 7]], cloudCol), 150, 52);
      g.drawImage(blob(40, 20, [[10, 13, 7], [20, 9, 9], [30, 13, 7]], cloudCol), 290, 8);
      // near hills + bushes
      const near = makeCanvas(448, VIEW_H);
      g = near.getContext('2d');
      const hillCol = { fill: '#3fae4a', outline: '#1d5a22', shade: '#2f8f3a', light: '#6fd36a' };
      const hill1 = blob(150, 80, [[75, 92, 80]], hillCol);
      const hill2 = blob(100, 50, [[50, 64, 56]], hillCol);
      g.drawImage(hill1, 10, 210 - 80);
      g.drawImage(hill2, 250, 210 - 50);
      // decorative stripes on hills
      g.fillStyle = '#2f8f3a';
      for (let i = 0; i < 6; i++) {
        g.fillRect(60 + i * 8, 150 + (i % 2) * 10, 2, 12);
        g.fillRect(290 + i * 6, 178 + (i % 2) * 6, 2, 8);
      }
      const bushCol = { fill: '#4cc04a', outline: '#1d5a22', shade: '#2f9a35', light: '#8ae878' };
      g.drawImage(blob(48, 18, [[10, 14, 9], [24, 10, 10], [38, 14, 9]], bushCol), 170, 208 - 17);
      g.drawImage(blob(34, 16, [[9, 12, 8], [24, 11, 9]], bushCol), 390, 208 - 15);
      BG.push({ sky, layers: [{ c: far, f: 0.12, y: 0, drift: 0 }, { c: clouds, f: 0.2, y: 6, drift: 4 }, { c: near, f: 0.45, y: 0, drift: 0 }] });
    }

    // ---- Crystal Cavern ----
    {
      const sky = skyStrip('#0a0716', '#22143e', 12);
      const far = makeCanvas(320, VIEW_H);
      let g = far.getContext('2d');
      g.fillStyle = '#1e1640';
      const spikes = [[10, 22, 70], [48, 14, 40], [90, 30, 95], [150, 18, 55], [200, 26, 80], [262, 16, 46], [296, 22, 66]];
      for (const [x0, w, len] of spikes) {
        for (let dy = 0; dy < len; dy++) {
          const hw = Math.floor((w / 2) * (1 - dy / len));
          g.fillRect(x0 + w / 2 - hw, dy + 30, hw * 2 + 1, 1);
        }
      }
      g.fillStyle = '#251b4e';
      const mites = [[30, 30, 60], [120, 40, 80], [230, 34, 70], [280, 20, 40]];
      for (const [x0, w, len] of mites) {
        for (let dy = 0; dy < len; dy++) {
          const hw = Math.floor((w / 2) * (1 - dy / len));
          g.fillRect(x0 + w / 2 - hw, 208 - dy, hw * 2 + 1, 1);
        }
      }
      g.fillStyle = '#4a3a8a';
      for (let i = 0; i < 40; i++) g.fillRect((i * 73) % 320, 40 + ((i * 37) % 150), 1, 1);
      const near = makeCanvas(400, VIEW_H);
      g = near.getContext('2d');
      const crystal = (x, base, h, w, c1, c2, c3) => {
        for (let dy = 0; dy < h; dy++) {
          const t = dy < h * 0.3 ? dy / (h * 0.3) : 1;
          const hw = Math.max(1, Math.floor(w * t / 2));
          const y = base - h + dy;
          g.fillStyle = c3; g.fillRect(x - hw - 1, y, 1, 1); g.fillRect(x + hw + 1, y, 1, 1);
          g.fillStyle = c1; g.fillRect(x - hw, y, hw, 1);
          g.fillStyle = c2; g.fillRect(x, y, hw + 1, 1);
        }
      };
      crystal(40, 212, 46, 12, '#7af0ff', '#38a8d8', '#123a5a');
      crystal(54, 212, 30, 9, '#ff8ae0', '#c048b0', '#4a1240');
      crystal(170, 212, 38, 10, '#b28aff', '#7048d0', '#24124a');
      crystal(184, 212, 24, 8, '#7af0ff', '#38a8d8', '#123a5a');
      crystal(300, 212, 52, 14, '#ff8ae0', '#c048b0', '#4a1240');
      crystal(318, 212, 28, 8, '#b28aff', '#7048d0', '#24124a');
      // hanging roots
      g.fillStyle = '#2c2058';
      for (let i = 0; i < 9; i++) {
        const x = 20 + i * 44;
        const len = 20 + ((i * 29) % 40);
        g.fillRect(x, 32, 2, len);
        g.fillRect(x + (i % 2 ? 1 : -1), 32 + len, 2, 4);
      }
      BG.push({ sky, layers: [{ c: far, f: 0.15, y: 0, drift: 0 }, { c: near, f: 0.45, y: 0, drift: 0 }] });
    }

    // ---- Ember Fortress ----
    {
      const sky = skyStrip('#120a12', '#4a1410', 12);
      const far = makeCanvas(256, VIEW_H);
      let g = far.getContext('2d');
      g.fillStyle = '#26161e';
      g.fillRect(0, 24, 256, 200);
      g.fillStyle = '#1a0e14';
      for (let y = 24; y < 224; y += 12) {
        g.fillRect(0, y, 256, 1);
        const off = ((y / 12) % 2) * 16;
        for (let x = off; x < 256; x += 32) g.fillRect(x, y, 1, 12);
      }
      const windowAt = (wx) => {
        for (let dy = 0; dy < 44; dy++) {
          let hw = 12;
          if (dy < 12) hw = Math.floor(Math.sqrt(144 - (12 - dy) * (12 - dy)));
          g.fillStyle = mixHex('#ffb04a', '#7a1a10', dy / 44);
          g.fillRect(wx - hw, 70 + dy, hw * 2, 1);
        }
        g.fillStyle = '#1a0e14';
        g.fillRect(wx - 1, 70, 2, 44);
        g.fillRect(wx - 12, 92, 24, 2);
      };
      windowAt(48);
      windowAt(176);
      const near = makeCanvas(384, VIEW_H);
      g = near.getContext('2d');
      const pillar = (x) => {
        g.fillStyle = '#3a2430'; g.fillRect(x, 20, 28, 200);
        g.fillStyle = '#4e3240'; g.fillRect(x, 20, 4, 200);
        g.fillStyle = '#24141c'; g.fillRect(x + 24, 20, 4, 200);
        g.fillStyle = '#4e3240'; g.fillRect(x - 4, 20, 36, 6); g.fillRect(x - 4, 200, 36, 8);
        // banner
        g.fillStyle = '#a8283a'; g.fillRect(x + 4, 40, 20, 44);
        g.fillStyle = '#6a1424'; g.fillRect(x + 20, 40, 4, 44);
        for (let i = 0; i < 6; i++) { g.fillStyle = '#a8283a'; g.fillRect(x + 4 + i * 2, 84, 2, 6 - i); g.fillRect(x + 22 - i * 2, 84, 2, 6 - i); }
        g.fillStyle = '#ffcf3f'; g.fillRect(x + 12, 52, 4, 4); g.fillRect(x + 10, 56, 8, 2); g.fillRect(x + 12, 58, 4, 8);
      };
      pillar(60);
      pillar(252);
      g.fillStyle = '#5a4450';
      for (let i = 0; i < 14; i++) g.fillRect(160 + (i % 2) * 2, 26 + i * 4, 2, 3);
      BG.push({ sky, layers: [{ c: far, f: 0.15, y: 0, drift: 0 }, { c: near, f: 0.42, y: 0, drift: 0 }] });
    }
    return BG;
  }

  function bakeCastle(pal) {
    const W = 80, H = 80;
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    const brickArea = (x, y, w, h) => {
      g.fillStyle = pal.base; g.fillRect(x, y, w, h);
      g.fillStyle = pal.mortar;
      for (let yy = y; yy < y + h; yy += 8) {
        g.fillRect(x, yy, w, 1);
        const off = (((yy - y) / 8) % 2) * 8;
        for (let xx = x + off; xx < x + w; xx += 16) g.fillRect(xx, yy, 1, 8);
      }
      g.fillStyle = pal.light; g.fillRect(x, y, w, 1);
    };
    // lower body + crenellations
    brickArea(0, 40, 80, 40);
    for (let i = 0; i < 5; i++) brickArea(i * 17, 32, 11, 9);
    // tower
    brickArea(20, 12, 40, 28);
    for (let i = 0; i < 3; i++) brickArea(20 + i * 15, 4, 10, 9);
    // door (arched)
    g.fillStyle = pal.door;
    for (let dy = 0; dy < 26; dy++) {
      let hw = 8;
      if (dy < 8) hw = Math.floor(Math.sqrt(64 - (8 - dy) * (8 - dy)));
      g.fillRect(40 - hw, 54 + dy, hw * 2, 1);
    }
    // windows
    g.fillRect(28, 20, 6, 10);
    g.fillRect(46, 20, 6, 10);
    // banner on tower
    g.fillStyle = pal.dark; g.fillRect(39, 0, 2, 6);
    g.fillStyle = '#ffd23f'; g.fillRect(41, 0, 6, 3);
    return c;
  }

  function bakeAll() {
    // Hero: SPR.hero[size][palette][frame] = [faceRight, faceLeft]
    SPR.hero = [[], []];
    for (let p = 0; p < HERO_PALS.length; p++) {
      const pal = HERO_PALS[p];
      const small = {};
      for (const name of Object.keys(SMALL_BODY)) {
        const rows = (name === 'dead' ? HERO_HEAD_DEAD : HERO_HEAD).concat(SMALL_BODY[name]);
        const c = bake(rows, pal, 16, 16);
        small[name] = [c, flipH(c)];
      }
      SPR.hero[0].push(small);
      const big = {};
      for (const name of Object.keys(BIG_LEGS)) {
        const torso = (name === 'jump' || name === 'wall') ? BIG_TORSO_UP : BIG_TORSO;
        const rows = HERO_HEAD.concat(torso, BIG_LEGS[name]);
        const c = bake(rows, pal, 16, 32);
        big[name] = [c, flipH(c)];
      }
      big.dead = small.dead;
      SPR.hero[1].push(big);
    }

    SPR.tiles = THEMES.map(th => ({
      top: bake(GROUND_TOP, th.ground),
      fill: bake(GROUND_FILL, th.ground),
      brick: bake(BRICK, th.brick),
      hard: bake(HARD, th.hard),
      used: bake(USED_BLOCK, th.used),
      ptl: bake(PIPE_TL, th.pipe),
      ptr: bake(PIPE_TR, th.pipe),
      pbl: bake(PIPE_BL, th.pipe),
      pbr: bake(PIPE_BR, th.pipe)
    }));
    SPR.q = Q_PALS.map(p => bake(QBLOCK, p));
    const lavaPal = { Y: '#ffe14d', O: '#ff8a1a', R: '#e0381a', r: '#a8200e' };
    SPR.lavaTop = [bake(LAVA_TOP, lavaPal), bake(LAVA_TOP_2, lavaPal)];
    SPR.lava = bake(LAVA_BODY, lavaPal);
    const coinPal = { K: '#6a3a00', Y: '#ffd23f', O: '#e09a1c', W: '#fff8d0' };
    const c0 = bake(COIN_F0, coinPal), c1 = bake(COIN_F1, coinPal), c2 = bake(COIN_F2, coinPal);
    SPR.coin = [c0, c1, c2, c1];
    SPR.berry = bake(BERRY, { K: '#2a0a12', R: '#ff3b5c', r: '#b0123a', W: '#ffffff', G: '#6ee05a', g: '#2a9a3a' });
    SPR.star = [
      bake(STAR, { K: '#6a4000', Y: '#ffe14d', W: '#ffffff', O: '#e0a018' }),
      bake(STAR, { K: '#6a4000', Y: '#fff3a8', W: '#ffffff', O: '#ffcf3f' })
    ];
    SPR.fire = [
      bake(FIREBALL, { Y: '#ffe14d', O: '#ff7a1a', W: '#fff8d0' }, 8, 8),
      bake(FIREBALL, { Y: '#ff9a2a', O: '#ff4a1a', W: '#ffe14d' }, 8, 8)
    ];
    SPR.flag = bake(FLAG, { K: '#0a3a2a', W: '#ffffff', G: '#1fb5a8' });
    SPR.ball = bake(BALL, { K: '#0a3a2a', G: '#4fd88a', g: '#1f8a4a', W: '#e8fff0' }, 8, 8);
    SPR.enemy = THEMES.map(th => {
      const f0 = bake(GLOOMP_F0, th.enemy), f1 = bake(GLOOMP_F1, th.enemy);
      return { walk: [f0, f1], squish: bake(GLOOMP_SQUISH, th.enemy) };
    });
    SPR.castle = THEMES.map(th => bakeCastle(th.castle));
    SPR.bg = bakeBackgrounds();

    // pixel font glyphs (white + gold), each 4x6 with a drop shadow
    SPR.font = {};
    for (const ch of Object.keys(FONT)) {
      const make = (col) => {
        const c = makeCanvas(4, 6);
        const g = c.getContext('2d');
        const rows = FONT[ch];
        for (let pass = 0; pass < 2; pass++) {
          g.fillStyle = pass === 0 ? '#1a1030' : col;
          for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
            if (rows[y][x] === '1') g.fillRect(x + (pass === 0 ? 1 : 0), y + (pass === 0 ? 1 : 0), 1, 1);
          }
        }
        return c;
      };
      SPR.font[ch] = [make('#ffffff'), make('#ffd23f')];
    }
  }

  // ===================================================================
  //  AUDIO — procedural chiptune (square / triangle / noise)
  // ===================================================================
  const TRACKS = {
    title: {
      bpm: 104,
      lead: [
        76, 0, 79, 0, 84, 0, 83, 79,
        81, 0, 77, 0, 74, 0, 0, 0,
        76, 0, 79, 0, 84, 0, 86, 88,
        86, 0, 84, 0, 0, 0, 0, 0,
        72, 0, 76, 0, 81, 0, 79, 76,
        77, 0, 74, 0, 71, 0, 0, 0,
        72, 0, 76, 79, 84, 83, 81, 79,
        84, 0, 0, 0, 0, 0, 0, 0
      ],
      bass: [48, 41, 48, 43, 45, 41, 43, 48],
      bassPat: [0, null, 7, null, 12, null, 7, null],
      drums: 'k.h.k.hh'
    },
    over: {
      bpm: 150,
      lead: [
        72, 0, 76, 79, 84, 0, 79, 76,
        77, 0, 74, 77, 81, 79, 77, 74,
        76, 0, 72, 76, 79, 0, 84, 83,
        81, 79, 77, 74, 72, 0, 0, 0,
        69, 0, 72, 76, 81, 0, 79, 76,
        77, 76, 74, 72, 74, 0, 67, 0,
        72, 0, 76, 79, 84, 83, 81, 79,
        77, 74, 71, 74, 72, 0, 0, 0
      ],
      bass: [48, 41, 48, 43, 45, 41, 48, 43],
      bassPat: [0, null, 12, null, 0, 7, 12, null],
      drums: 'k.hsk.hs'
    },
    cave: {
      bpm: 112,
      lead: [
        69, 0, 0, 72, 0, 76, 0, 0,
        74, 0, 72, 0, 71, 0, 0, 0,
        69, 0, 0, 72, 0, 76, 0, 79,
        77, 0, 76, 0, 74, 0, 0, 0,
        72, 0, 0, 76, 0, 79, 0, 0,
        81, 0, 79, 0, 77, 0, 76, 0,
        74, 0, 72, 0, 71, 0, 68, 0,
        69, 0, 0, 0, 0, 0, 0, 0
      ],
      bass: [45, 41, 45, 40, 48, 41, 40, 45],
      bassPat: [0, null, null, 12, null, null, 7, null],
      drums: 'k...h...'
    },
    castle: {
      bpm: 138,
      lead: [
        74, 0, 73, 0, 74, 0, 77, 76,
        74, 0, 73, 0, 70, 0, 69, 0,
        74, 0, 73, 0, 74, 0, 77, 81,
        80, 0, 77, 0, 74, 0, 73, 0,
        70, 0, 69, 0, 70, 0, 74, 0,
        73, 0, 69, 0, 65, 0, 69, 0,
        70, 72, 74, 0, 77, 76, 74, 73,
        74, 0, 0, 0, 62, 0, 0, 0
      ],
      bass: [38, 38, 34, 33, 34, 33, 31, 33],
      bassPat: [0, 0, 12, 0, 0, 12, 0, 12],
      drums: 'k.skk.sh'
    }
  };

  const Sound = {
    ctx: null, master: null, sfxBus: null, musicBus: null, noiseBuf: null,
    sfxOn: prefs.sound, musicOn: prefs.music, muted: false, primed: false,
    track: null, trackName: '', step: 0, nextTime: 0, speed: 1, playing: false, paused: false,
    silent: false, // set while the title-screen demo simulates, so it never makes noise

    unlock() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioCtx !== 'function') return;
        try {
          this.ctx = new AudioCtx({ latencyHint: 'interactive' });
        } catch {
          try {
            this.ctx = new AudioCtx();
          } catch {
            this.ctx = null;
            return;
          }
        }
        const c = this.ctx;
        this.master = c.createGain();
        this.master.gain.value = this.muted ? 0 : 0.8;
        this.master.connect(c.destination);
        this.sfxBus = c.createGain();
        this.sfxBus.gain.value = this.sfxOn ? 0.55 : 0;
        this.sfxBus.connect(this.master);
        this.musicBus = c.createGain();
        this.musicBus.gain.value = this.musicOn ? 0.3 : 0;
        this.musicBus.connect(this.master);
        const len = c.sampleRate;
        this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      // Handle both standard 'suspended' and iOS Safari 'interrupted' states
      if (this.ctx.state !== 'running') {
        this.ctx.resume().then(() => { this.nextTime = 0; }).catch(() => { /* needs a user gesture */ });
      }
      // Prime iOS WebKit audio hardware once on the first user gesture
      if (!this.primed && this.ctx && this.master) {
        this.primed = true;
        try {
          const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
          const s = this.ctx.createBufferSource();
          s.buffer = b;
          s.connect(this.master);
          s.start(0);
          s.addEventListener('ended', () => { s.disconnect(); }, { once: true });
        } catch {
          /* ignore */
        }
      }
    },
    /** Release the audio thread while the tab is hidden. */
    sleep() {
      this.nextTime = 0;
      if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => { /* ignore */ });
    },
    ok() { return !!this.ctx && this.ctx.state === 'running'; },
    ramp(param, v) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.setTargetAtTime(v, t, 0.03);
    },
    setMuted(m) { this.muted = m; if (this.master) this.ramp(this.master.gain, m ? 0 : 0.8); },
    setSfx(on) { this.sfxOn = on; if (this.sfxBus) this.ramp(this.sfxBus.gain, on ? 0.55 : 0); },
    setMusic(on) { this.musicOn = on; if (this.musicBus) this.ramp(this.musicBus.gain, on ? 0.3 : 0); this.nextTime = 0; },

    toneAt(when, type, f0, f1, dur, vol, bus) {
      const c = this.ctx;
      const t0 = Math.max(c.currentTime, when);
      const d = Math.max(0.01, dur);
      const atk = Math.min(0.006, d * 0.4);
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(20, f0), t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + d);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g);
      g.connect(bus || this.sfxBus);
      o.start(t0);
      o.stop(t0 + d + 0.03);
      o.addEventListener('ended', () => { o.disconnect(); g.disconnect(); }, { once: true });
    },
    noiseAt(when, dur, vol, freq, bus, type = 'bandpass') {
      const c = this.ctx;
      const t0 = Math.max(c.currentTime, when);
      const d = Math.max(0.01, dur);
      const s = c.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, vol), t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      s.connect(f);
      f.connect(g);
      g.connect(bus || this.sfxBus);
      s.start(t0, Math.random() * 0.5);
      s.stop(t0 + d + 0.02);
      s.addEventListener('ended', () => { s.disconnect(); f.disconnect(); g.disconnect(); }, { once: true });
    },
    tone(type, f0, f1, dur, vol, delay = 0) {
      if (!this.ok() || !this.sfxOn) return;
      this.toneAt(this.ctx.currentTime + delay, type, f0, f1, dur, vol);
    },
    noise(dur, vol, freq, delay = 0, type = 'bandpass') {
      if (!this.ok() || !this.sfxOn) return;
      this.noiseAt(this.ctx.currentTime + delay, dur, vol, freq, null, type);
    },
    seq(notes, stepDur, type, vol, delay = 0) {
      for (let i = 0; i < notes.length; i++) {
        const m = notes[i];
        if (m) this.tone(type, midi(m), midi(m), stepDur * 0.92, vol, delay + i * stepDur);
      }
    },

    play(name) {
      if (this.silent || !this.ok() || !this.sfxOn) return;
      switch (name) {
        case 'jump': this.tone('square', 330, 720, 0.16, 0.14); break;
        case 'bigjump': this.tone('square', 220, 560, 0.2, 0.14); break;
        case 'vault': this.tone('square', 480, 900, 0.08, 0.1); this.tone('triangle', 240, 480, 0.1, 0.18, 0.02); break;
        case 'highvault': this.tone('square', 300, 1200, 0.26, 0.13); this.tone('square', 600, 1600, 0.16, 0.06, 0.09); break;
        case 'spin': this.tone('triangle', 500, 1300, 0.09, 0.25); this.tone('triangle', 1300, 500, 0.09, 0.25, 0.09); this.noise(0.16, 0.05, 6000); break;
        case 'kick': this.noise(0.05, 0.2, 1500); this.tone('square', 520, 980, 0.12, 0.12, 0.02); break;
        case 'coin': this.tone('square', 988, 988, 0.08, 0.11); this.tone('square', 1319, 1319, 0.3, 0.11, 0.075); break;
        case 'bump': this.tone('triangle', 170, 70, 0.1, 0.4); this.tone('square', 110, 90, 0.06, 0.07); break;
        case 'break': this.noise(0.3, 0.32, 900); this.tone('square', 180, 60, 0.15, 0.1); break;
        case 'sprout': this.seq([60, 64, 67, 72, 64, 67, 72, 76], 0.045, 'square', 0.08); break;
        case 'powerup': this.seq([67, 72, 76, 79, 84, 79, 84, 88, 91], 0.05, 'square', 0.1); break;
        case 'star': this.seq([72, 76, 79, 84, 88, 91, 96], 0.04, 'square', 0.1); this.seq([60, 64, 67, 72], 0.07, 'triangle', 0.2); break;
        case 'stomp': this.tone('square', 480, 120, 0.12, 0.14); this.noise(0.08, 0.16, 2500); break;
        case 'flip': this.tone('square', 900, 200, 0.2, 0.11); this.noise(0.1, 0.12, 4000); break;
        case 'shrink': this.tone('square', 700, 180, 0.4, 0.13); this.tone('square', 600, 150, 0.4, 0.07, 0.05); break;
        case 'oneup': this.seq([76, 79, 88, 84, 86, 91], 0.08, 'square', 0.11); break;
        case 'skid': this.noise(0.14, 0.12, 1400); break;
        case 'die': this.seq([71, 77, 0, 77, 77, 76, 74, 72, 64, 0, 60], 0.11, 'square', 0.12); break;
        case 'flag': this.tone('square', 1500, 180, 0.9, 0.1); this.tone('triangle', 750, 90, 0.9, 0.2); break;
        case 'fanfare':
          this.seq([67, 72, 76, 79, 84, 88, 91, 0, 88, 0, 91, 91, 91, 91], 0.1, 'square', 0.11);
          this.seq([48, 0, 52, 0, 55, 0, 60, 0, 55, 0, 60, 60, 60, 60], 0.1, 'triangle', 0.25);
          break;
        case 'gameover': this.seq([72, 0, 67, 0, 64, 0, 69, 71, 69, 68, 70, 68, 67, 0, 0, 60], 0.14, 'square', 0.11); this.seq([48, 0, 43, 0, 40, 0, 45, 0, 44, 0, 46, 0, 43], 0.14, 'triangle', 0.22); break;
        case 'pause': this.tone('square', 660, 660, 0.06, 0.1); this.tone('square', 990, 990, 0.08, 0.1, 0.08); break;
        case 'tick': this.tone('square', 1760, 1760, 0.025, 0.05); break;
        case 'select': this.tone('square', 880, 1320, 0.06, 0.08); break;
        case 'checkpoint': this.seq([72, 79, 84], 0.07, 'square', 0.1); break;
        case 'start': this.seq([72, 76, 79, 84, 88], 0.05, 'square', 0.09); break;
        case 'whoosh': this.noise(0.38, 0.12, 700, 0, 'lowpass'); this.tone('triangle', 900, 160, 0.36, 0.14); break;
        default: break;
      }
    },

    startMusic(name) {
      this.trackName = name;
      this.track = TRACKS[name] || null;
      this.step = 0;
      this.nextTime = 0;
      this.playing = !!this.track;
      this.paused = false;
    },
    stopMusic() { this.playing = false; },
    pauseMusic(p) { this.paused = p; if (!p) this.nextTime = 0; },
    update() {
      if (!this.ok() || !this.playing || this.paused || !this.track || !this.musicOn) return;
      const c = this.ctx;
      const tr = this.track;
      const stepDur = 60 / (tr.bpm * this.speed) / 2;
      if (this.nextTime < c.currentTime) this.nextTime = c.currentTime + 0.05;
      let guard = 0;
      while (this.nextTime < c.currentTime + 0.18 && guard++ < 16) {
        this.scheduleStep(this.step, this.nextTime, stepDur);
        this.nextTime += stepDur;
        this.step = (this.step + 1) % tr.lead.length;
      }
    },
    scheduleStep(i, t, d) {
      const tr = this.track;
      const bus = this.musicBus;
      const ln = tr.lead[i];
      if (ln) this.toneAt(t, 'square', midi(ln), midi(ln), d * 0.85, 0.1, bus);
      const bar = Math.floor(i / 8), pos = i % 8;
      const root = tr.bass[bar % tr.bass.length];
      const off = tr.bassPat[pos];
      if (off !== null) this.toneAt(t, 'triangle', midi(root + off), midi(root + off), d * 0.9, 0.32, bus);
      const dr = tr.drums[pos];
      if (dr === 'k') this.toneAt(t, 'sine', 150, 45, 0.12, 0.45, bus);
      else if (dr === 's') this.noiseAt(t, 0.1, 0.22, 1800, bus);
      else if (dr === 'h') this.noiseAt(t, 0.035, 0.1, 8000, bus, 'highpass');
    }
  };

  // ===================================================================
  //  LEVELS
  // ===================================================================
  const ROW_CODES = new Map([
    ['B', T_BRICK], ['?', T_QCOIN], ['M', T_QBERRY], ['S', T_QSTAR], ['X', T_HARD],
    ['o', T_COIN], ['C', T_MBRICK], ['U', T_USED], ['#', T_GROUND]
  ]);

  class Level {
    constructor(theme, width, endless = false) {
      this.theme = theme;
      this.endless = endless;
      this.cols = [];
      this.colTheme = [];
      this.offset = 0;
      this.spawns = [];
      this.firebars = [];
      this.flag = null;
      this.castle = null;
      this.checkpoint = 0;
      this.mcoins = new Map();
      this.genX = 0;
      this.genTheme = theme;
      this.lastChunk = '';
      if (width > 0) this.ensure(width - 1, theme);
    }
    get end() { return this.offset + this.cols.length; }
    get pixelWidth() { return this.end * TILE; }
    ensure(cx, theme = this.genTheme) {
      while (this.end <= cx) {
        this.cols.push(new Uint8Array(ROWS));
        this.colTheme.push(theme);
      }
    }
    get(cx, cy) {
      if (cy >= ROWS) return T_EMPTY;
      const i = cx - this.offset;
      if (i < 0) return T_HARD;
      if (i >= this.cols.length) return this.endless ? T_EMPTY : T_HARD;
      if (cy < 0) return T_EMPTY;
      return this.cols[i][cy];
    }
    set(cx, cy, v) {
      if (cy < 0 || cy >= ROWS || cx < this.offset) return;
      this.ensure(cx);
      this.cols[cx - this.offset][cy] = v;
    }
    themeAt(cx) {
      if (!this.colTheme.length) return this.theme;
      return this.colTheme[clamp(cx - this.offset, 0, this.colTheme.length - 1)];
    }
    fill(x0, y0, x1, y1, v) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.set(x, y, v);
    }
    ground(x0, x1, top = 13) { this.fill(x0, top, x1, ROWS - 1, T_GROUND); }
    ceil(x0, x1, bottom = 1) { this.fill(x0, 0, x1, bottom, T_GROUND); }
    lava(x0, x1) {
      for (let x = x0; x <= x1; x++) { this.set(x, 13, T_LAVA_TOP); this.set(x, 14, T_LAVA); }
    }
    row(x, y, str) {
      for (let i = 0; i < str.length; i++) {
        const id = ROW_CODES.get(str[i]);
        if (id !== undefined) this.set(x + i, y, id);
      }
    }
    coins(x, y, n) { for (let i = 0; i < n; i++) this.set(x + i, y, T_COIN); }
    coinCol(x, y0, y1) { for (let y = y0; y <= y1; y++) this.set(x, y, T_COIN); }
    arc(x, y, n) {
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5;
        this.set(x + i, y - Math.round(Math.sin(t * Math.PI) * 2), T_COIN);
      }
    }
    pipe(x, h, base = 12) {
      const top = base - h + 1;
      this.set(x, top, T_PTL);
      this.set(x + 1, top, T_PTR);
      for (let y = top + 1; y <= base; y++) { this.set(x, y, T_PBL); this.set(x + 1, y, T_PBR); }
    }
    stairsUp(x, n, base = 12) {
      for (let i = 0; i < n; i++) this.fill(x + i, base - i, x + i, base, T_HARD);
    }
    stairsDown(x, n, base = 12) {
      for (let i = 0; i < n; i++) this.fill(x + i, base - (n - i) + 1, x + i, base, T_HARD);
    }
    enemy(x, row = 12) { this.spawns.push({ x: x * TILE + 1, y: row * TILE + 2 }); }
    firebar(cx, cy, len, speed) {
      this.set(cx, cy, T_HARD);
      this.firebars.push({ x: cx * TILE + 8, y: cy * TILE + 8, len, speed, ang: rand(0, Math.PI * 2) });
    }
    flagAt(cx) {
      this.set(cx, 12, T_HARD);
      this.flag = { cx, x: cx * TILE + 8, topY: 2 * TILE + 8, baseY: 12 * TILE, flagY: 2 * TILE + 12, triggerX: cx * TILE };
    }
    castleAt(cx) { this.castle = { x: cx * TILE, doorX: cx * TILE + 40 }; }
    finish() { this.spawns.sort((a, b) => a.x - b.x); return this; }
  }

  // ---- Stage 1: Grasslands ----
  function buildStage1() {
    const L = new Level(0, 214);
    L.ground(0, 49);
    L.row(9, 9, '?');
    L.row(14, 9, 'B?BMB');
    L.row(16, 5, '?');
    L.enemy(21);
    L.coins(23, 12, 3);
    L.pipe(28, 2);
    L.arc(31, 9, 5);
    L.fill(35, 12, 36, 12, T_HARD);
    L.enemy(39);
    L.pipe(42, 3);
    L.coins(45, 12, 3);
    L.ground(52, 88);
    L.enemy(55);
    L.enemy(57);
    L.row(60, 9, 'BBC?BBB');
    L.row(62, 5, 'BSB');
    L.coins(68, 12, 4);
    L.pipe(72, 2);
    L.enemy(76);
    L.pipe(79, 3);
    L.stairsUp(85, 4);
    L.ground(91, 140);
    L.stairsDown(91, 4);
    L.checkpoint = 100;
    L.row(102, 9, '?M?');
    L.enemy(106);
    L.row(109, 9, 'BBBB');
    L.coins(109, 6, 4);
    L.enemy(114);
    L.enemy(116);
    L.fill(119, 12, 119, 12, T_HARD);
    L.fill(123, 11, 123, 12, T_HARD);
    L.pipe(127, 2);
    L.arc(130, 8, 6);
    L.pipe(134, 3);
    L.ground(144, 213);
    L.row(148, 9, 'B?B?B');
    L.enemy(151);
    L.enemy(153);
    L.enemy(155);
    L.fill(159, 12, 159, 12, T_HARD);
    L.row(162, 9, 'BBBBBB');
    L.coins(162, 7, 6);
    L.pipe(171, 2);
    L.enemy(175);
    L.fill(178, 12, 179, 12, T_HARD);
    L.stairsUp(184, 8);
    L.fill(192, 5, 192, 12, T_HARD);
    L.flagAt(199);
    L.castleAt(204);
    return L.finish();
  }

  // ---- Stage 2: Crystal Cavern (wall-kick shafts) ----
  function buildStage2() {
    const L = new Level(1, 226);
    L.ceil(0, 125);
    L.ceil(147, 186);
    L.ground(0, 40);
    L.row(9, 9, 'B?B');
    L.row(14, 9, 'BBMBB');
    L.enemy(18);
    L.enemy(20);
    L.coins(23, 12, 4);
    L.fill(28, 12, 29, 12, T_HARD);
    L.fill(32, 11, 33, 12, T_HARD);
    L.row(36, 8, 'C');
    L.enemy(38);
    L.ground(44, 82);
    // low corridor
    L.fill(46, 2, 56, 7, T_GROUND);
    L.row(47, 8, 'BB?BBB?BBB');
    L.coins(48, 12, 8);
    L.enemy(51);
    L.enemy(54);
    // wall-kick shaft A
    L.fill(60, 2, 62, 9, T_GROUND);
    L.fill(66, 5, 82, 12, T_GROUND);
    L.coinCol(64, 4, 10);
    L.coins(69, 4, 5);
    L.coins(76, 4, 4);
    L.ground(83, 120);
    L.row(88, 9, 'B?BSB?B');
    L.enemy(93);
    L.enemy(95);
    L.enemy(97);
    L.pipe(101, 3);
    L.checkpoint = 106;
    L.row(110, 9, '?M?');
    L.enemy(115);
    L.fill(122, 10, 123, 10, T_HARD);
    L.ground(125, 170);
    // wall-kick shaft B (open to the sky for extra headroom)
    L.fill(126, 0, 127, 1, T_GROUND);
    L.fill(128, 0, 129, 9, T_GROUND);
    L.fill(133, 4, 146, 12, T_GROUND);
    L.coinCol(131, 3, 10);
    L.coins(137, 3, 6);
    L.row(152, 9, '??');
    L.enemy(156);
    L.enemy(158);
    L.fill(162, 12, 162, 12, T_HARD);
    L.coins(165, 12, 3);
    L.ground(174, 225);
    L.pipe(177, 2);
    L.enemy(181);
    L.pipe(185, 3);
    L.stairsUp(190, 6);
    L.fill(196, 7, 196, 12, T_HARD);
    L.flagAt(204);
    L.castleAt(209);
    return L.finish();
  }

  // ---- Stage 3: Ember Fortress (lava + firebars) ----
  function buildStage3() {
    const L = new Level(2, 222);
    L.ceil(0, 178);
    L.ground(0, 30);
    L.enemy(12);
    L.fill(16, 12, 16, 12, T_HARD);
    L.row(19, 9, '?M?');
    L.firebar(25, 7, 4, 1.4);
    L.lava(31, 33);
    L.ground(34, 60);
    L.enemy(40);
    L.firebar(46, 8, 4, -1.4);
    L.coins(50, 10, 3);
    L.enemy(55);
    L.lava(61, 66);
    L.fill(63, 11, 64, 14, T_HARD);
    L.ground(67, 140);
    L.row(70, 9, 'BCB');
    L.enemy(74);
    L.enemy(76);
    L.firebar(80, 8, 5, 1.3);
    L.coins(84, 12, 3);
    L.lava(88, 90);
    L.checkpoint = 94;
    L.fill(100, 2, 114, 7, T_GROUND);
    L.row(101, 8, '?BBSBB?BB?');
    L.enemy(105);
    L.enemy(108);
    L.enemy(111);
    L.lava(116, 118);
    L.firebar(124, 12, 3, 1.1);
    L.fill(130, 11, 131, 12, T_HARD);
    L.coins(134, 12, 4);
    L.lava(141, 146);
    L.fill(143, 10, 144, 14, T_HARD);
    L.ground(147, 221);
    L.firebar(152, 8, 5, -1.4);
    L.enemy(157);
    L.enemy(159);
    L.enemy(161);
    L.row(164, 9, '?M?');
    L.lava(170, 172);
    L.stairsUp(182, 6);
    L.fill(188, 7, 188, 12, T_HARD);
    L.flagAt(196);
    L.castleAt(201);
    return L.finish();
  }

  const STAGE_BUILDERS = [buildStage1, buildStage2, buildStage3];

  // ---- Endless mode: procedural chunk generator ----
  function eBase(L, x0, x1, z) {
    L.ensure(x1, z);
    L.ground(x0, x1);
    if (z > 0) L.ceil(x0, x1);
  }
  function eVoid(L, x0, x1, z) {
    L.ensure(x1, z);
    if (z > 0) L.ceil(x0, x1);
    if (z === 2) L.lava(x0, x1);
  }
  const CHUNKS = {
    flat(L, x, d, z) {
      const n = randi(5, 8);
      eBase(L, x, x + n - 1, z);
      if (chance(0.5)) L.coins(x + 1, chance(0.5) ? 12 : 10, n - 2);
      return x + n;
    },
    gap(L, x, d, z) {
      eBase(L, x, x + 2, z);
      const w = randi(2, 2 + Math.round(d * 2));
      eVoid(L, x + 3, x + 2 + w, z);
      eBase(L, x + 3 + w, x + 5 + w, z);
      if (chance(0.5)) L.arc(x + 3, 9, w);
      return x + 6 + w;
    },
    pipe(L, x, d, z) {
      eBase(L, x, x + 7, z);
      L.pipe(x + 2, randi(2, 3));
      if (chance(0.6)) L.enemy(x + 6);
      return x + 8;
    },
    enemies(L, x, d, z) {
      eBase(L, x, x + 9, z);
      const n = randi(1, 2 + Math.round(d));
      for (let i = 0; i < n; i++) L.enemy(x + 3 + i * 2);
      return x + 10;
    },
    blocks(L, x, d, z) {
      eBase(L, x, x + 9, z);
      let s = '';
      for (let i = 0; i < 5; i++) {
        const r = Math.random();
        s += r < 0.07 ? 'M' : r < 0.1 ? 'S' : r < 0.45 ? '?' : r < 0.52 ? 'C' : 'B';
      }
      L.row(x + 2, 9, s);
      if (chance(0.5)) L.coins(x + 2, 6, 5);
      if (chance(0.5)) L.enemy(x + 8);
      return x + 10;
    },
    stairs(L, x, d, z) {
      const n = randi(3, 4);
      eBase(L, x, x + n, z);
      L.stairsUp(x + 1, n);
      eVoid(L, x + n + 1, x + n + 2, z);
      eBase(L, x + n + 3, x + 2 * n + 5, z);
      L.stairsDown(x + n + 3, n);
      return x + 2 * n + 6;
    },
    ledges(L, x, d, z) {
      eBase(L, x, x + 11, z);
      L.fill(x + 2, 12, x + 2, 12, T_HARD);
      L.fill(x + 6, 12, x + 7, 12, T_HARD);
      if (chance(0.5)) L.fill(x + 10, 12, x + 10, 12, T_HARD);
      L.coins(x + 3, 10, 3);
      return x + 12;
    },
    platforms(L, x, d, z) {
      // two 3-wide stepping platforms: gaps of 2, 2 and 1 tiles
      eBase(L, x, x + 1, z);
      eVoid(L, x + 2, x + 12, z);
      L.fill(x + 4, 11, x + 6, 11, T_HARD);
      L.fill(x + 9, 10, x + 11, 10, T_HARD);
      L.coins(x + 9, 8, 3);
      eBase(L, x + 13, x + 15, z);
      return x + 16;
    },
    shaft(L, x, d, z) {
      eBase(L, x, x + 16, z);
      L.fill(x + 3, 2, x + 5, 9, T_GROUND);
      L.fill(x + 9, 5, x + 16, 12, T_GROUND);
      L.coinCol(x + 7, 4, 10);
      return x + 17;
    },
    firebar(L, x, d, z) {
      eBase(L, x, x + 9, z);
      if (chance(0.5)) L.firebar(x + 5, 12, 3, chance(0.5) ? 1.1 : -1.1);
      else L.firebar(x + 5, 8, 5, chance(0.5) ? 1.3 : -1.3);
      return x + 10;
    },
    lavaPillar(L, x, d, z) {
      eBase(L, x, x + 1, z);
      eVoid(L, x + 2, x + 7, z);
      L.fill(x + 4, 11, x + 5, 14, T_HARD);
      eBase(L, x + 8, x + 10, z);
      return x + 11;
    }
  };
  const CHUNK_WEIGHTS = [
    [['flat', 2], ['gap', 2], ['pipe', 2], ['enemies', 2], ['blocks', 2], ['stairs', 1], ['ledges', 1], ['platforms', 1]],
    [['flat', 2], ['gap', 2], ['enemies', 2], ['blocks', 2], ['ledges', 1], ['platforms', 1], ['shaft', 1.5], ['pipe', 1]],
    [['flat', 2], ['gap', 2], ['enemies', 2], ['blocks', 1], ['firebar', 2], ['lavaPillar', 1.5], ['ledges', 1]]
  ];
  function pickChunk(z) {
    const list = CHUNK_WEIGHTS[z];
    let total = 0;
    for (const [, w] of list) total += w;
    let r = Math.random() * total;
    for (const [name, w] of list) {
      r -= w;
      if (r <= 0) return name;
    }
    return list[0][0];
  }
  function genEndless(L, untilCol) {
    let guard = 0;
    while (L.genX < untilCol && guard++ < 64) {
      const x = L.genX;
      const z = Math.floor(x / 200) % 3;
      L.genTheme = z;
      const d = Math.min(1, x / 1200);
      if (x < 18) {
        eBase(L, x, x + 17, z);
        L.genX = x + 18;
        continue;
      }
      // keep 3 safe tiles at the start of each zone
      if (x % 200 < 3) {
        eBase(L, x, x + 3, z);
        L.genX = x + 4;
        continue;
      }
      // after a raised shaft exit, always land on open ground before the next obstacle
      const name = L.lastChunk === 'shaft' ? 'flat' : pickChunk(z);
      L.genX = CHUNKS[name](L, x, d, z);
      L.lastChunk = name;
    }
  }

  // ===================================================================
  //  DOM / CANVAS / ADAPTIVE DEVICE PROFILE
  // ===================================================================
  const $ = id => document.getElementById(id);
  const rootEl = document.documentElement;
  const appEl = $('app');
  const stageWrapEl = $('stage-wrap');
  const stageEl = $('stage');
  const canvas = $('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const previewCanvas = $('preview');
  const pctx = previewCanvas ? previewCanvas.getContext('2d') : null;
  const touchUiEl = $('touch-ui');
  const jumpBtnEl = $('btn-jump');
  const jumpLblEl = $('jump-lbl');
  let viewW = 426;
  let inputOverride = null; // null (auto) | 'touch' | 'desktop' (dynamic for hybrid devices)
  let resizeTimer = 0;
  let lastJumpCue = 'JUMP';

  const matchQuery = q => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

  function getViewportSize() {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) return { w: vv.width, h: vv.height };
    return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
  }

  function detectDeviceProfile(ww, wh) {
    const coarse = matchQuery('(pointer: coarse)');
    const anyCoarse = matchQuery('(any-pointer: coarse)');
    const fine = matchQuery('(pointer: fine)');
    const hover = matchQuery('(hover: hover)');
    const maxTouch = navigator.maxTouchPoints || 0;
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && maxTouch > 1);
    const isAndroid = /Android/i.test(ua);
    const isMobileUA = isIOS || isAndroid || /Mobile|Silk|Kindle|PlayBook/i.test(ua);

    const shortSide = Math.min(ww, wh);
    const longSide = Math.max(ww, wh);
    const touchPrimary = coarse || isMobileUA || (maxTouch > 0 && !hover && !fine);

    let device = 'desktop';
    if (touchPrimary) {
      device = (shortSide <= 560 && longSide <= 1024) ? 'phone' : 'tablet';
    } else if (anyCoarse && shortSide <= 560) {
      device = 'phone';
    }

    const inputMode = inputOverride || (touchPrimary ? 'touch' : 'desktop');
    const orientation = wh > ww ? 'portrait' : 'landscape';
    return { device, input: inputMode, orientation };
  }

  function applyDeviceProfile(ww, wh) {
    const prof = detectDeviceProfile(ww, wh);
    if (rootEl.dataset.device !== prof.device) rootEl.dataset.device = prof.device;
    if (rootEl.dataset.input !== prof.input) rootEl.dataset.input = prof.input;
    if (rootEl.dataset.orientation !== prof.orientation) rootEl.dataset.orientation = prof.orientation;
    return prof;
  }

  function resize() {
    const vp = getViewportSize();
    applyDeviceProfile(vp.w, vp.h);

    // Measure stage-wrap after layout attributes apply so portrait 3-zone mode never overlaps HUD or touch deck
    const rect = stageWrapEl ? stageWrapEl.getBoundingClientRect() : null;
    const aw = rect && rect.width > 16 ? rect.width : vp.w;
    const ah = rect && rect.height > 16 ? rect.height : vp.h;

    viewW = Math.round(clamp(VIEW_H * (aw / ah), 256, 576));
    if (canvas.width !== viewW) canvas.width = viewW;
    if (canvas.height !== VIEW_H) canvas.height = VIEW_H;
    const scale = Math.min(aw / viewW, ah / VIEW_H);
    stageEl.style.width = Math.max(1, Math.floor(viewW * scale)) + 'px';
    stageEl.style.height = Math.max(1, Math.floor(VIEW_H * scale)) + 'px';
    ctx.imageSmoothingEnabled = false;

    // Keep camera cleanly bounded if the device rotated mid-run or while paused
    if (level && player) {
      camLook = player.dir > 0 ? viewW * 0.36 : viewW * 0.62;
      const minCam = level.offset * TILE;
      const maxCam = level.endless ? Infinity : level.pixelWidth - viewW;
      camX = clamp(player.x + player.w / 2 - camLook, minCam, Math.max(minCam, maxCam));
      prevCam = camX;
    }
  }

  function scheduleResize() {
    resize();
    window.requestAnimationFrame(resize);
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      resize();
    }, 160);
  }

  // ===================================================================
  //  GAME STATE
  // ===================================================================
  let state = 'menu'; // menu | playing | paused | clear | gameover
  let level = null;
  let player = null;
  let session = null;
  const enemies = [];
  const powerups = [];
  const particles = [];
  const popups = [];
  const coinPops = [];
  const bumps = [];
  let spawnIdx = 0;
  let camX = 0, prevCam = 0, camLook = 150;
  let worldTime = 0;
  let acc = 0;
  let selectedMode = 0;
  let bgTheme = 0, bgPrev = 0, bgFade = 1;
  let tally = null;
  let bannerT = 0;

  // presentation / "juice"
  const reduceMotion = matchQuery('(prefers-reduced-motion: reduce)');
  let wipe = null;     // iris transition: { mode: 'open' | 'close', t, dur, done }
  let shake = 0;       // screen-shake amplitude (px)
  let hitStop = 0;     // tiny freeze on impactful hits
  const ghosts = [];   // afterimages for spins / high vaults / star power
  let errorCount = 0;  // throttles console reporting if something goes wrong

  // attract mode (the game plays itself behind the title screen)
  let demoStage = 0;
  const demoAI = { held: false, holdT: 0, prevWall: false, blockedT: 0, lastX: 0 };
  const demoWatch = { x: 0, t: 0 };

  function addShake(px) { if (!reduceMotion) shake = Math.max(shake, px); }
  function squash(p, sx, sy) { if (!reduceMotion) { p.sx = sx; p.sy = sy; } }

  const input = { queued: false, pressed: false, held: false, pointer: false };
  const keysDown = new Set();
  const JUMP_KEYS = new Set(['Space', 'KeyW', 'ArrowUp']);

  // ===================================================================
  //  PHYSICS — tile collision with sub-stepped AABB sweeps
  // ===================================================================
  const isSolid = (cx, cy) => SOLID[level.get(cx, cy)] === 1;

  function rectSolid(x, y, w, h) {
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 0.01) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 0.01) / TILE);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (isSolid(cx, cy)) return true;
    return false;
  }

  function rectHasTile(x, y, w, h, table) {
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 0.01) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 0.01) / TILE);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (table[level.get(cx, cy)]) return true;
    return false;
  }

  /** Horizontal sweep in <=4px sub-steps. Returns blocking column or null. */
  function moveX(e, dx) {
    if (dx === 0) return null;
    const n = Math.max(1, Math.ceil(Math.abs(dx) / 4));
    const s = dx / n;
    for (let i = 0; i < n; i++) {
      e.x += s;
      const y0 = Math.floor(e.y / TILE), y1 = Math.floor((e.y + e.h - 0.01) / TILE);
      if (s > 0) {
        const cx = Math.floor((e.x + e.w - 0.01) / TILE);
        for (let cy = y0; cy <= y1; cy++) {
          if (isSolid(cx, cy)) { e.x = cx * TILE - e.w; return cx; }
        }
      } else {
        const cx = Math.floor(e.x / TILE);
        for (let cy = y0; cy <= y1; cy++) {
          if (isSolid(cx, cy)) { e.x = (cx + 1) * TILE; return cx; }
        }
      }
    }
    return null;
  }

  /** Vertical sweep in <=4px sub-steps. Returns 1 landed, -1 ceiling, 0 free. */
  function moveY(e, dy, cornerNudge = false) {
    if (dy === 0) return 0;
    const n = Math.max(1, Math.ceil(Math.abs(dy) / 4));
    const s = dy / n;
    for (let i = 0; i < n; i++) {
      e.y += s;
      const x0 = Math.floor(e.x / TILE), x1 = Math.floor((e.x + e.w - 0.01) / TILE);
      if (s > 0) {
        const cy = Math.floor((e.y + e.h - 0.01) / TILE);
        for (let cx = x0; cx <= x1; cx++) {
          if (isSolid(cx, cy)) { e.y = cy * TILE - e.h; return 1; }
        }
      } else {
        const cy = Math.floor(e.y / TILE);
        let hit = null, hits = 0;
        const mid = e.x + e.w / 2;
        for (let cx = x0; cx <= x1; cx++) {
          if (isSolid(cx, cy)) {
            hits++;
            if (hit === null || Math.abs(cx * TILE + 8 - mid) < Math.abs(hit * TILE + 8 - mid)) hit = cx;
          }
        }
        if (hit !== null) {
          // corner correction: slide past a block edge clipped by only a few pixels
          if (cornerNudge && hits === 1 && x0 !== x1) {
            const overL = (hit + 1) * TILE - e.x;      // overlap if the block is on our left
            const overR = e.x + e.w - hit * TILE;      // overlap if the block is on our right
            const oldX = e.x;
            if (hit === x0 && overL <= 5) e.x = (hit + 1) * TILE;
            else if (hit === x1 && overR <= 5) e.x = hit * TILE - e.w;
            if (e.x !== oldX && !rectSolid(e.x, e.y, e.w, e.h)) continue;
            e.x = oldX;
          }
          e.y = (cy + 1) * TILE;
          e.hitCX = hit;
          e.hitCY = cy;
          return -1;
        }
      }
    }
    return 0;
  }

  // ===================================================================
  //  EFFECTS
  // ===================================================================
  function addParticle(p) {
    if (particles.length >= MAX_PARTICLES) return;
    particles.push(p);
  }
  function dust(x, y, n = 4) {
    for (let i = 0; i < n; i++) {
      addParticle({ type: 'dust', x: x + rand(-3, 3), y: y + rand(-2, 1), vx: rand(-30, 30), vy: rand(-40, -10), life: rand(0.25, 0.45), max: 0.45, col: '#e8e0d0', size: 2, g: 0, dead: false });
    }
  }
  function sparkle(x, y, n = 6, col = '#fff6a0') {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(30, 90);
      addParticle({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.6), max: 0.6, col, size: 2, g: 0, dead: false });
    }
  }
  function brickBurst(cx, cy, th) {
    const pal = THEMES[th].brick;
    for (let i = 0; i < 4; i++) {
      addParticle({ type: 'brick', x: cx * TILE + 4 + (i % 2) * 8, y: cy * TILE + 4 + Math.floor(i / 2) * 8, vx: (i % 2 ? 1 : -1) * rand(50, 80), vy: i < 2 ? -300 : -220, life: 1.4, max: 1.4, col: pal.R, col2: pal.m, size: 5, g: 1200, dead: false });
    }
  }
  function popup(x, y, text, gold = false) {
    popups.push({ x, y, text: String(text), life: 0.9, gold, dead: false });
  }

  // ===================================================================
  //  SCORE / SESSION
  // ===================================================================
  function addScore(n, x, y, show = true) {
    session.score += n;
    if (show && x !== undefined) popup(x, y, n);
  }
  function addCoin(x, y) {
    session.coins++;
    session.stageCoins++;
    Sound.play('coin');
    if (session.coins % 100 === 0) {
      if (session.mode === 'endless') addScore(1000, x, y - 10);
      else { session.lives++; popup(x, y - 10, '1UP', true); Sound.play('oneup'); }
    }
  }
  function commitHigh() {
    if (session && !session.demo && session.score > highScore) {
      highScore = session.score;
      Store.save('pixeldash.high', highScore);
      return true;
    }
    return false;
  }

  // ===================================================================
  //  PLAYER
  // ===================================================================
  function newPlayer(x, groundY, big) {
    const w = big ? 12 : 10, h = big ? 28 : 14;
    return {
      x, y: groundY - h, px: x, py: groundY - h, w, h, vx: 0, vy: 0, dir: 1, big,
      onGround: false, coyote: 0, jumpBuffer: 0, jumping: false, hold: 0, minHold: 0,
      spin: 0, spinUsed: false, vaulting: false, vaultT: 0, wallT: 0, wallDir: 0, wallSliding: false,
      turnTimer: 0, skid: 0, invuln: 0, star: 0, anim: 0, state: 'play', deadTime: 0,
      pendingGrow: false, growAnim: 0, combo: 0, flagPhase: '', flagT: 0, hidden: false, hitCX: 0, hitCY: 0,
      sx: 1, sy: 1, ghostT: 0, wipeStarted: false
    };
  }

  function setBig(p, big) {
    if (big === p.big) return true;
    if (big) {
      const nw = 12, nh = 28, nx = p.x - 1, ny = p.y + p.h - nh;
      if (rectSolid(nx, ny, nw, nh)) return false;
      p.x = nx; p.y = ny; p.w = nw; p.h = nh; p.big = true;
    } else {
      p.y = p.y + p.h - 14; p.x += 1; p.w = 10; p.h = 14; p.big = false;
    }
    p.px = p.x; p.py = p.y;
    return true;
  }

  function grow(p) {
    Sound.play('powerup');
    if (setBig(p, true)) p.growAnim = 0.6;
    else p.pendingGrow = true;
  }

  function hurt(p) {
    if (p.invuln > 0 || p.star > 0 || p.state !== 'play') return;
    if (p.big) {
      setBig(p, false);
      p.invuln = 2;
      p.growAnim = 0.6;
      p.pendingGrow = false;
      Sound.play('shrink');
      addShake(3);
    } else {
      die(p, false);
    }
  }

  function die(p, pit) {
    if (p.state === 'dead') return;
    p.state = 'dead';
    p.deadTime = pit ? 0.5 : 0;
    p.vy = pit ? 0 : -330;
    p.star = 0;
    if (!session.demo) {
      Sound.speed = 1;
      Sound.stopMusic();
    }
    Sound.play('die');
    addShake(pit ? 1 : 4);
  }

  function nearGround(p) { return rectSolid(p.x, p.y + p.h, p.w, 14); }

  function startVault(p, v) {
    p.vy = -v;
    p.onGround = false;
    p.coyote = 0;
    p.vaulting = true;
    p.vaultT = VAULT_WINDOW;
    p.jumping = false;
    Sound.play('vault');
    dust(p.x + p.w / 2, p.y + p.h, 3);
    squash(p, 0.85, 1.15);
  }

  function tryAutoVault(p, bx) {
    const footRow = Math.floor((p.y + p.h - 0.01) / TILE);
    if (!isSolid(bx, footRow)) return false;
    const need = Math.ceil(p.h / TILE);
    for (let k = 1; k <= need; k++) if (isSolid(bx, footRow - k)) return false;
    const x0 = Math.floor(p.x / TILE), x1 = Math.floor((p.x + p.w - 0.01) / TILE);
    for (let cx = x0; cx <= x1; cx++) if (isSolid(cx, footRow - need)) return false;
    startVault(p, VAULT_V);
    return true;
  }

  function doJump(p) {
    p.vy = -(p.big ? BIG_JUMP_V : JUMP_V);
    p.onGround = false;
    p.coyote = 0;
    p.jumping = true;
    p.hold = 0;
    p.minHold = 0;
    p.jumpBuffer = 0;
    p.vaulting = false;
    p.vaultT = 0;
    p.skid = 0;
    Sound.play(p.big ? 'bigjump' : 'jump');
    squash(p, 0.78, 1.25);
  }

  function doHighVault(p) {
    p.vy = -HIGH_VAULT_V;
    p.onGround = false;
    p.coyote = 0;
    p.jumping = true;
    p.hold = 0;
    p.minHold = 0.08;
    p.vaulting = false;
    p.vaultT = 0;
    p.jumpBuffer = 0;
    Sound.play('highvault');
    sparkle(p.x + p.w / 2, p.y + p.h, 6, '#bff8ff');
    squash(p, 0.7, 1.35);
    addShake(1.5);
  }

  function doWallKick(p) {
    p.dir = -p.wallDir;
    p.vy = -KICK_V;
    p.jumping = true;
    p.hold = 0;
    p.minHold = 0.14;
    p.wallT = 0;
    p.wallSliding = false;
    p.spin = 0;
    p.spinUsed = false;
    p.vaulting = false;
    p.jumpBuffer = 0;
    p.turnTimer = 0;
    Sound.play('kick');
    squash(p, 0.8, 1.2);
    dust(p.wallDir > 0 ? p.x + p.w : p.x, p.y + p.h / 2, 5);
  }

  function doSpin(p) {
    p.spin = SPIN_TIME;
    p.spinUsed = true;
    p.vy = Math.min(p.vy, -SPIN_LIFT);
    p.jumping = false;
    p.vaulting = false;
    p.jumpBuffer = 0;
    Sound.play('spin');
    sparkle(p.x + p.w / 2, p.y + p.h / 2, 5, '#ffffff');
  }

  function updatePlayer(dt) {
    const p = player;
    p.px = p.x;
    p.py = p.y;
    p.anim += dt;
    p.sx += (1 - p.sx) * Math.min(1, dt * 12);
    p.sy += (1 - p.sy) * Math.min(1, dt * 12);
    if (p.invuln > 0) p.invuln -= dt;
    if (p.growAnim > 0) p.growAnim -= dt;
    if (p.star > 0) {
      p.star -= dt;
      if (chance(0.35)) sparkle(p.x + rand(0, p.w), p.y + rand(0, p.h), 1, ['#ff6ad5', '#7af0ff', '#ffe14d', '#7cff6b'][randi(0, 3)]);
      if (p.star <= 0) { p.star = 0; Sound.speed = 1; }
    }

    if (p.state === 'dead') {
      p.deadTime += dt;
      if (p.deadTime > 0.5) {
        p.vy = Math.min(p.vy + G_FALL * dt, MAX_FALL * 1.5);
        p.y += p.vy * dt;
      }
      if (p.deadTime > 2.3 && !p.wipeStarted) {
        p.wipeStarted = true;
        const finalDeath = !session.demo && (session.mode === 'endless' || session.lives <= 1);
        if (finalDeath) onDeathDone();               // straight to the Game Over screen
        else startWipe('close', 0.55, onDeathDone);  // iris out, respawn, iris in
      }
      return;
    }
    if (p.state === 'flag') { updateFlag(p, dt); return; }

    if (p.pendingGrow && setBig(p, true)) { p.pendingGrow = false; p.growAnim = 0.6; }

    // ---- input buffering ----
    if (input.pressed) p.jumpBuffer = 0.13;
    else if (p.jumpBuffer > 0) p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);

    // ---- automatic run + turnaround after wall-kicks ----
    const speed = RUN_SPEED * (p.star > 0 ? STAR_MULT : 1);
    if (p.onGround && p.dir < 0 && p.skid <= 0) {
      p.turnTimer += dt;
      if (p.turnTimer > 0.45) { p.skid = 0.22; Sound.play('skid'); }
    } else if (!p.onGround) {
      p.turnTimer = 0;
    }
    if (p.skid > 0) {
      p.skid -= dt;
      p.vx = p.dir * speed * Math.max(0, p.skid / 0.22) * 0.6;
      if (chance(0.4)) dust(p.x + p.w / 2, p.y + p.h, 1);
      if (p.skid <= 0) { p.skid = 0; p.dir = 1; p.turnTimer = 0; }
    } else if (p.spin > 0) {
      p.vx = p.dir * speed * SPIN_MULT;
    } else {
      p.vx = p.dir * speed;
    }

    // ---- jump / vault / wall-kick / spin ----
    if (p.jumpBuffer > 0) {
      if (p.vaultT > 0 && !p.onGround) doHighVault(p);
      else if (p.onGround || p.coyote > 0) doJump(p);
      else if (p.wallT > 0) doWallKick(p);
      else if (input.pressed && !p.spinUsed && !(p.vy > 0 && nearGround(p))) doSpin(p);
    }

    // ---- gravity (variable jump height) ----
    let g;
    if (p.spin > 0) { p.spin = Math.max(0, p.spin - dt); g = G_SPIN; }
    else if (p.vaulting) g = G_FALL;
    else if (p.vy < 0 && p.jumping && (input.held || p.hold < p.minHold) && p.hold < HOLD_MAX) g = G_HOLD;
    else if (p.vy < 0 && p.jumping) g = G_RELEASE;
    else g = G_FALL;
    if (p.jumping) p.hold += dt;
    p.vy = Math.min(p.vy + g * dt, p.spin > 0 ? 60 : MAX_FALL);
    if (p.wallSliding && p.vy > WALL_SLIDE_MAX) p.vy = WALL_SLIDE_MAX;

    // ---- horizontal move ----
    const wasGround = p.onGround;
    const bx = moveX(p, p.vx * dt);
    p.wallSliding = false;
    if (bx !== null && p.vx !== 0) {
      const bdir = p.vx > 0 ? 1 : -1;
      // vault 1-tile steps from the ground, or mid-air when feet are level with the step top
      const vaulted = (wasGround || p.vy > -60) && tryAutoVault(p, bx);
      if (!vaulted && !wasGround) {
        p.wallDir = bdir;
        p.wallT = 0.12;
        if (p.vy > 0) {
          p.wallSliding = true;
          p.spin = 0;
          if (chance(0.25)) dust(bdir > 0 ? p.x + p.w : p.x, p.y + 4, 1);
        }
      }
    } else if (p.wallT > 0) {
      p.wallT -= dt;
    }
    // left edge of the world
    const minX = level.offset * TILE;
    if (p.x < minX) p.x = minX;

    // ---- vertical move ----
    p.onGround = false;
    const r = moveY(p, p.vy * dt, true);
    if (r === 1) {
      if (p.vy > 260) dust(p.x + p.w / 2, p.y + p.h, 3);
      if (p.vy > 160) squash(p, 1.25, 0.78);
      p.onGround = true;
      p.vy = 0;
      p.jumping = false;
      p.vaulting = false;
      p.spin = 0;
      p.spinUsed = false;
      p.coyote = 0.08;
      p.combo = 0;
      p.wallT = 0;
    } else if (r === -1) {
      if (p.vy < 0) {
        bumpTile(p.hitCX, p.hitCY);
        p.vy = 30;
        p.jumping = false;
        p.spin = 0;
        p.vaulting = false;
      }
    }
    if (!p.onGround && p.coyote > 0) p.coyote -= dt;
    if (p.vaultT > 0) p.vaultT -= dt;

    // ---- auto-vault over small grounded enemies ----
    if (p.onGround && !p.vaulting && p.skid <= 0) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.state !== 'walk') continue;
        const ahead = p.dir > 0 ? e.x - (p.x + p.w) : p.x - (e.x + e.w);
        if (ahead >= -3 && ahead < 12 && Math.abs((e.y + e.h) - (p.y + p.h)) < 6) {
          startVault(p, ENEMY_VAULT_V);
          break;
        }
      }
    }

    // ---- afterimages for spins, high vaults and star power ----
    p.ghostT -= dt;
    if (p.ghostT <= 0 && (p.spin > 0 || p.star > 0 || (p.jumping && p.vy < -360))) {
      p.ghostT = 0.04;
      if (ghosts.length < 12) {
        const img = heroImage(p);
        ghosts.push({ img, x: p.x + p.w / 2 - 8, y: p.y + p.h - img.height, life: 0.24, dead: false });
      }
    }

    // ---- coins, hazards, pits ----
    collectCoinsAt(p);
    if (rectHasTile(p.x + 2, p.y + 4, p.w - 4, p.h - 4, LETHAL)) { die(p, false); return; }
    if (p.y > VIEW_H + 24) { die(p, true); return; }

    // ---- checkpoint & flag ----
    if (session.mode === 'stage' && level.checkpoint && !session.checkpoint && p.x > level.checkpoint * TILE) {
      session.checkpoint = true;
      Sound.play('checkpoint');
      popup(p.x, p.y - 8, '+', true);
    }
    const f = level.flag;
    if (f && p.x + p.w >= f.triggerX - 0.5) grabFlag(p, f);
  }

  function collectCoinsAt(p) {
    const x0 = Math.floor(p.x / TILE), x1 = Math.floor((p.x + p.w - 0.01) / TILE);
    const y0 = Math.floor(p.y / TILE), y1 = Math.floor((p.y + p.h - 0.01) / TILE);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      if (level.get(cx, cy) === T_COIN) {
        level.set(cx, cy, T_EMPTY);
        addCoin(cx * TILE + 8, cy * TILE);
        addScore(100);
        sparkle(cx * TILE + 8, cy * TILE + 8, 4);
      }
    }
  }

  function grabFlag(p, f) {
    p.state = 'flag';
    p.flagPhase = 'slide';
    p.y = Math.max(p.y, f.topY);
    const height = f.baseY - (p.y + p.h);
    const bonus = height >= 136 ? 5000 : height >= 104 ? 2000 : height >= 72 ? 800 : height >= 40 ? 400 : height >= 16 ? 200 : 100;
    session.flagBonus = bonus;
    addScore(bonus, f.x + 4, p.y - 6);
    p.x = f.x - p.w - 1;
    p.px = p.x; p.py = p.y;
    p.vx = 0; p.vy = 0; p.spin = 0; p.dir = 1;
    p.wallSliding = false;
    if (!session.demo) {
      Sound.stopMusic();
      Sound.speed = 1;
    }
    Sound.play('flag');
  }

  function updateFlag(p, dt) {
    const f = level.flag;
    if (p.flagPhase === 'slide') {
      p.y = Math.min(p.y + 130 * dt, f.baseY - p.h);
      f.flagY = Math.min(f.flagY + 130 * dt, f.baseY - 17);
      if (p.y >= f.baseY - p.h && f.flagY >= f.baseY - 17) { p.flagPhase = 'hold'; p.flagT = 0.35; }
    } else if (p.flagPhase === 'hold') {
      p.flagT -= dt;
      if (p.flagT <= 0) {
        p.flagPhase = 'walk';
        p.x = f.x + 2;
        p.px = p.x;
        Sound.play('fanfare');
      }
    } else if (p.flagPhase === 'walk') {
      p.vx = 70;
      p.vy = Math.min(p.vy + G_FALL * dt, MAX_FALL);
      moveX(p, p.vx * dt);
      p.onGround = false;
      if (moveY(p, p.vy * dt) === 1) { p.onGround = true; p.vy = 0; }
      if (level.castle && p.x + p.w / 2 >= level.castle.doorX) {
        p.flagPhase = 'enter';
        p.hidden = true;
        p.flagT = 1.2;
        for (let i = 0; i < 4; i++) sparkle(level.castle.doorX + rand(-30, 30), rand(100, 150), 10, ['#ffd23f', '#ff6ad5', '#7af0ff', '#7cff6b'][i]);
      }
    } else if (p.flagPhase === 'enter') {
      p.flagT -= dt;
      if (p.flagT <= 0) { p.flagPhase = 'done'; stageClear(); }
    }
  }

  // ===================================================================
  //  BLOCKS & ITEMS
  // ===================================================================
  function bumpTile(cx, cy) {
    const id = level.get(cx, cy);
    if (!SOLID[id]) return;
    const th = level.themeAt(cx);
    let bumped = false;
    if (id === T_QCOIN || id === T_QBERRY || id === T_QSTAR) {
      level.set(cx, cy, T_USED);
      bumped = true;
      if (id === T_QCOIN) blockCoin(cx, cy);
      else spawnPowerup(cx, cy, id === T_QSTAR ? 'star' : 'berry');
    } else if (id === T_MBRICK) {
      const key = cx * ROWS + cy;
      const left = (level.mcoins.has(key) ? level.mcoins.get(key) : 6) - 1;
      blockCoin(cx, cy);
      bumped = true;
      if (left <= 0) { level.set(cx, cy, T_USED); level.mcoins.delete(key); }
      else level.mcoins.set(key, left);
    } else if (id === T_BRICK) {
      if (player.big) {
        level.set(cx, cy, T_EMPTY);
        brickBurst(cx, cy, th);
        addScore(50);
        Sound.play('break');
        addShake(2);
      } else {
        bumped = true;
        Sound.play('bump');
      }
    } else {
      Sound.play('bump');
    }
    if (bumped) bumps.push({ cx, cy, t: 0.2, dead: false });
    // knock out enemies standing on top of the block
    const top = { x: cx * TILE, y: cy * TILE - 6, w: TILE, h: 6 };
    for (const e of enemies) {
      if (e.state === 'walk' && overlap(e, top)) { flipEnemy(e, cx * TILE + 8); addScore(100, e.x, e.y - 4); }
    }
    for (const pu of powerups) {
      if (!pu.emerge && overlap(pu, top)) { pu.vy = -220; pu.dir = (pu.x + pu.w / 2 < cx * TILE + 8) ? -1 : 1; }
    }
    // coin sitting on top of the block
    if (level.get(cx, cy - 1) === T_COIN) {
      level.set(cx, cy - 1, T_EMPTY);
      blockCoin(cx, cy);
    }
  }

  function blockCoin(cx, cy) {
    coinPops.push({ x: cx * TILE, y: cy * TILE - 16, vy: -300, t: 0.55, dead: false });
    addCoin(cx * TILE + 8, cy * TILE);
  }

  function spawnPowerup(cx, cy, kind) {
    powerups.push({
      kind, x: cx * TILE + 1, y: cy * TILE + 2, px: cx * TILE + 1, py: cy * TILE + 2, w: 14, h: 14,
      vx: 0, vy: 0, dir: 1, emerge: 0.6, targetY: cy * TILE - 14, dead: false, hitCX: 0, hitCY: 0
    });
    Sound.play('sprout');
  }

  function updatePowerups(dt) {
    const viewR = camX + viewW + 64;
    for (const pu of powerups) {
      pu.px = pu.x;
      pu.py = pu.y;
      if (pu.emerge > 0) {
        pu.emerge -= dt;
        pu.y = Math.max(pu.targetY, pu.y - (16 / 0.6) * dt);
        if (pu.emerge <= 0) { pu.y = pu.targetY; pu.vy = pu.kind === 'star' ? -200 : 0; }
        continue;
      }
      const sp = pu.kind === 'star' ? 78 : 55;
      pu.vy = Math.min(pu.vy + (pu.kind === 'star' ? 1000 : G_FALL) * dt, MAX_FALL);
      if (moveX(pu, pu.dir * sp * dt) !== null) pu.dir = -pu.dir;
      const r = moveY(pu, pu.vy * dt);
      if (r === 1) pu.vy = pu.kind === 'star' ? -280 : 0;
      else if (r === -1) pu.vy = 20;
      if (pu.y > VIEW_H + 32 || pu.x < camX - 96 || pu.x > viewR + 400) pu.dead = true;
    }
    compactDead(powerups);
  }

  function collectPowerup(pu) {
    pu.dead = true;
    const p = player;
    if (pu.kind === 'berry') {
      addScore(1000, pu.x, pu.y - 4);
      if (!p.big) grow(p);
      else Sound.play('powerup');
    } else {
      addScore(1000, pu.x, pu.y - 4);
      p.star = STAR_TIME;
      if (!session.demo) Sound.speed = 1.4;
      Sound.play('star');
    }
    sparkle(pu.x + 7, pu.y + 7, 10, pu.kind === 'star' ? '#ffe14d' : '#ff8aa0');
  }

  // ===================================================================
  //  ENEMIES & HAZARDS
  // ===================================================================
  function spawnEnemies() {
    // Spawn relative to the player (not the camera edge) so enemy timing is
    // identical on every screen aspect ratio. 380px is past the widest view.
    const limit = Math.max(player.x + 380, camX + viewW + 24);
    while (spawnIdx < level.spawns.length && level.spawns[spawnIdx].x < limit) {
      const s = level.spawns[spawnIdx++];
      if (s.skip) continue;
      enemies.push({ x: s.x, y: s.y, px: s.x, py: s.y, w: 14, h: 14, vx: 0, vy: 0, dir: -1, state: 'walk', t: 0, anim: rand(0, 1), dead: false, theme: level.themeAt(Math.floor(s.x / TILE)), hitCX: 0, hitCY: 0 });
    }
  }

  function flipEnemy(e, fromX) {
    e.state = 'flip';
    e.vy = -240;
    e.vx = (e.x + e.w / 2 < fromX ? -1 : 1) * 60;
    Sound.play('flip');
  }

  function updateEnemies(dt) {
    for (const e of enemies) {
      e.px = e.x;
      e.py = e.y;
      if (e.state === 'squish') {
        e.t -= dt;
        if (e.t <= 0) e.dead = true;
        continue;
      }
      if (e.state === 'flip') {
        e.vy += G_FALL * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.y > VIEW_H + 40) e.dead = true;
        continue;
      }
      e.anim += dt;
      e.vy = Math.min(e.vy + G_FALL * dt, MAX_FALL);
      if (moveX(e, e.dir * ENEMY_SPEED * dt) !== null) e.dir = -e.dir;
      const r = moveY(e, e.vy * dt);
      if (r !== 0) e.vy = 0;
      if (rectHasTile(e.x + 2, e.y + 6, e.w - 4, e.h - 6, LETHAL)) { e.state = 'flip'; e.vy = -150; e.vx = 0; }
      if (e.y > VIEW_H + 32 || e.x < camX - 128 || e.x > camX + viewW + 600) e.dead = true;
    }
    // walkers bounce off each other
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      if (a.state !== 'walk') continue;
      for (let j = i + 1; j < enemies.length; j++) {
        const b = enemies[j];
        if (b.state !== 'walk' || !overlap(a, b)) continue;
        if (a.x < b.x) { a.dir = -1; b.dir = 1; } else { a.dir = 1; b.dir = -1; }
      }
    }
    compactDead(enemies);
  }

  function updateFirebars(dt) {
    for (const fb of level.firebars) fb.ang += fb.speed * dt;
    if (level.endless && level.firebars.length) {
      let j = 0;
      for (const fb of level.firebars) if (fb.x > camX - 160) level.firebars[j++] = fb;
      level.firebars.length = j;
    }
  }

  function circleRect(cx, cy, r, x, y, w, h) {
    const nx = clamp(cx, x, x + w), ny = clamp(cy, y, y + h);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function collidePlayer() {
    const p = player;
    if (p.state !== 'play') return;
    // enemies
    for (const e of enemies) {
      if (e.state !== 'walk' || !overlap(p, e)) continue;
      if (p.star > 0) {
        flipEnemy(e, p.x + p.w / 2);
        addScore(200, e.x, e.y - 4);
        continue;
      }
      const prevBottom = p.py + p.h;
      if (p.vy > 0 && prevBottom <= e.y + 7) {
        // stomp!
        e.state = 'squish';
        e.t = 0.5;
        const table = [100, 200, 400, 800, 1000, 2000, 4000, 8000];
        if (p.combo >= table.length) {
          if (session.mode === 'endless') addScore(8000, e.x, e.y - 4);
          else { session.lives++; popup(e.x, e.y - 4, '1UP', true); Sound.play('oneup'); }
        } else {
          addScore(table[p.combo], e.x, e.y - 4);
        }
        p.combo++;
        p.y = e.y - p.h;
        p.vy = -STOMP_V;
        p.jumping = true;
        p.hold = 0;
        p.minHold = 0;
        p.vaulting = false;
        p.spin = 0;
        p.spinUsed = false;
        Sound.play('stomp');
        dust(e.x + 7, e.y + 10, 4);
        hitStop = 0.045;
        addShake(1.5);
        squash(p, 0.8, 1.25);
      } else if (p.vaulting && p.vy < 0) {
        // vaulting clean over a minor enemy — no damage
      } else {
        hurt(p);
      }
    }
    // powerups
    for (const pu of powerups) {
      if (pu.dead || (pu.emerge > 0.35)) continue;
      if (overlap(p, pu)) collectPowerup(pu);
    }
    // firebars
    if (p.star <= 0 && p.invuln <= 0) {
      for (const fb of level.firebars) {
        if (Math.abs(fb.x - (p.x + p.w / 2)) > fb.len * 8 + 24) continue;
        const ca = Math.cos(fb.ang), sa = Math.sin(fb.ang);
        for (let i = 0; i < fb.len; i++) {
          const r = i * 8;
          if (circleRect(fb.x + ca * r, fb.y + sa * r, 3.2, p.x, p.y, p.w, p.h)) { hurt(p); break; }
        }
        if (p.state !== 'play') break;
      }
    }
  }

  // ===================================================================
  //  EFFECT UPDATES
  // ===================================================================
  function updateEffects(dt) {
    for (const pt of particles) {
      pt.life -= dt;
      if (pt.life <= 0) { pt.dead = true; continue; }
      pt.vy += pt.g * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      if (pt.wob !== undefined) pt.y += Math.sin(worldTime * 2.2 + pt.wob) * 8 * dt;
      if (pt.y > VIEW_H + 20 || pt.x < camX - 40 || pt.x > camX + viewW + 40) pt.dead = true;
    }
    compactDead(particles);
    for (const pp of popups) {
      pp.life -= dt;
      pp.y -= 28 * dt;
      if (pp.life <= 0) pp.dead = true;
    }
    compactDead(popups);
    for (const cp of coinPops) {
      cp.t -= dt;
      cp.vy += 1000 * dt;
      cp.y += cp.vy * dt;
      if (cp.t <= 0) {
        cp.dead = true;
        popup(cp.x + 4, cp.y + 4, 200);
        addScore(200);
      }
    }
    compactDead(coinPops);
    for (const b of bumps) {
      b.t -= dt;
      if (b.t <= 0) b.dead = true;
    }
    compactDead(bumps);
    for (const gh of ghosts) {
      gh.life -= dt;
      if (gh.life <= 0) gh.dead = true;
    }
    compactDead(ghosts);

    // ambient lava embers
    const c0 = Math.floor(camX / TILE);
    if (chance(0.12)) {
      const cx = c0 + randi(0, Math.ceil(viewW / TILE));
      if (level.get(cx, 13) === T_LAVA_TOP) {
        addParticle({ type: 'ember', x: cx * TILE + rand(2, 14), y: 13 * TILE + 4, vx: rand(-8, 8), vy: rand(-60, -30), life: rand(0.6, 1.2), max: 1.2, col: chance(0.5) ? '#ffcf3f' : '#ff7a1a', size: 1, g: 0, dead: false });
      }
    }

    // ambient atmosphere: pollen (grasslands), fireflies + drips (cavern), ash (fortress)
    if (bgTheme === 0) {
      if (chance(0.04)) {
        addParticle({ type: 'mote', x: camX + rand(0, viewW + 30), y: rand(30, 200), vx: rand(-16, -6), vy: rand(-3, 3), life: rand(3, 5), max: 5, col: chance(0.5) ? '#fffbe0' : '#eaffb0', size: 1, g: 0, wob: rand(0, 6), dead: false });
      }
    } else if (bgTheme === 1) {
      if (chance(0.03)) {
        addParticle({ type: 'glow', x: camX + rand(0, viewW), y: rand(40, 200), vx: rand(-10, 10), vy: rand(-6, 6), life: rand(2.5, 4), max: 4, col: chance(0.5) ? '#7af0ff' : '#ff8ae0', size: 1, g: 0, wob: rand(0, 6), dead: false });
      }
      if (chance(0.025)) {
        const cx = c0 + randi(0, Math.ceil(viewW / TILE));
        if (isSolid(cx, 1) && !isSolid(cx, 2)) {
          addParticle({ type: 'drip', x: cx * TILE + rand(3, 13), y: 2 * TILE, vx: 0, vy: 0, life: 1.4, max: 1.4, col: '#9fd8ff', size: 1, g: 520, dead: false });
        }
      }
    } else if (chance(0.03)) {
      addParticle({ type: 'mote', x: camX + rand(0, viewW), y: rand(60, 220), vx: rand(-6, 6), vy: rand(-22, -10), life: rand(2.5, 4), max: 4, col: chance(0.6) ? '#8a7a80' : '#ff9a4a', size: 1, g: 0, wob: rand(0, 6), dead: false });
    }
  }

  function updateCamera(dt) {
    const p = player;
    const desired = p.dir > 0 ? viewW * 0.36 : viewW * 0.62;
    camLook += (desired - camLook) * Math.min(1, dt * 2.5);
    let target = p.x + p.w / 2 - camLook;
    const minCam = level.offset * TILE;
    const maxCam = level.endless ? Infinity : level.pixelWidth - viewW;
    target = clamp(target, minCam, Math.max(minCam, maxCam));
    if (p.state === 'dead') return;
    camX = target;
  }

  function endlessUpdate() {
    const camCol = Math.floor(camX / TILE);
    if (level.end < camCol + 64) genEndless(level, camCol + 80);
    const drop = (camCol - 40) - level.offset;
    if (drop > 0) {
      level.cols.splice(0, drop);
      level.colTheme.splice(0, drop);
      level.offset += drop;
      for (const key of level.mcoins.keys()) if (Math.floor(key / ROWS) < level.offset) level.mcoins.delete(key);
    }
    if (spawnIdx > 32) {
      level.spawns.splice(0, spawnIdx);
      spawnIdx = 0;
    }
    if (player.state === 'play') {
      const dist = Math.floor(player.x / TILE);
      if (dist > session.maxDist) {
        session.score += (dist - session.maxDist) * 10;
        session.maxDist = dist;
      }
    }
    if (!session.passedBest && bestDistance >= 20 && session.maxDist > bestDistance) {
      session.passedBest = true;
      Sound.play('checkpoint');
      showBanner('NEW RECORD', `${bestDistance} m beaten!`);
      sparkle(player.x + player.w / 2, player.y, 12, '#ffd23f');
    }
    const centerCol = Math.floor((camX + viewW / 2) / TILE);
    const z = level.themeAt(centerCol);
    if (z !== session.zone) {
      session.zone = z;
      bgPrev = bgTheme;
      bgTheme = z;
      bgFade = 0;
      if (player.state === 'play') Sound.startMusic(TRACK_FOR_THEME[z]);
      showBanner('ZONE ' + (Math.floor(Math.max(0, centerCol) / 200) + 1), THEME_NAMES[z]);
    }
  }

  // ===================================================================
  //  FLOW: start / load / death / clear / game over / transitions
  // ===================================================================
  function newSession(mode, stage) {
    const endless = mode === 'endless';
    return {
      mode: endless ? 'endless' : 'stage',
      stage: endless ? 0 : clamp(Number(stage) || 0, 0, STAGE_BUILDERS.length - 1),
      score: 0, coins: 0, lives: endless ? 1 : 3, big: false,
      stageCoins: 0, stageTime: 0, flagBonus: 0, checkpoint: false,
      maxDist: 0, zone: 0, stageStartScore: 0, stageStartCoins: 0,
      passedBest: false, demo: false
    };
  }

  function startRun(mode) {
    Sound.unlock();
    wipe = null;
    hudCache.clear();
    session = newSession(mode, mode);
    loadStage(false);
  }

  /** Attract mode: a silent self-playing run behind the title screen. */
  function startDemo(stage) {
    demoStage = stage % STAGE_BUILDERS.length;
    session = newSession('stage', demoStage);
    session.demo = true;
    session.lives = 99;
    loadStage(false);
  }

  // ---------- iris transition ----------
  function startWipe(mode, dur, done = null) {
    wipe = { mode, dur, t: 0, done };
  }

  function updateWipe(dt) {
    if (!wipe) return;
    wipe.t += dt;
    if (wipe.t < wipe.dur) return;
    const { mode, done } = wipe;
    wipe = null;
    if (done) done();
    if (mode === 'close' && !wipe) startWipe('open', 0.45);
  }

  /** Close the iris, then run `fn` (which loads something and re-opens it). */
  function transition(fn) {
    if (state === 'wipe') return;
    setState('wipe');
    Sound.play('whoosh');
    startWipe('close', 0.45, fn);
  }

  function clearEntities() {
    enemies.length = 0;
    powerups.length = 0;
    particles.length = 0;
    popups.length = 0;
    coinPops.length = 0;
    bumps.length = 0;
    ghosts.length = 0;
    spawnIdx = 0;
    shake = 0;
    hitStop = 0;
  }

  function loadStage(fromCheckpoint) {
    clearEntities();
    let theme;
    if (session.mode === 'endless') {
      level = new Level(0, 0, true);
      genEndless(level, 90);
      theme = 0;
      session.zone = 0;
      session.maxDist = 2;
    } else {
      level = STAGE_BUILDERS[session.stage]();
      theme = level.theme;
    }
    if (!fromCheckpoint) {
      session.checkpoint = false;
      session.stageStartScore = session.score;
      session.stageStartCoins = session.coins;
    }
    session.stageCoins = 0;
    session.stageTime = 0;
    session.flagBonus = 0;

    let startCol = 2;
    if (fromCheckpoint && session.checkpoint && level.checkpoint) startCol = level.checkpoint;
    let groundRow = 13;
    for (let cy = 2; cy < ROWS; cy++) {
      if (isSolid(startCol, cy)) { groundRow = cy; break; }
    }
    player = newPlayer(startCol * TILE + 3, groundRow * TILE, session.big);
    player.onGround = true;
    // don't spawn enemies right on top of a respawn point
    for (const s of level.spawns) if (s.x < player.x + 4 * TILE) s.skip = true;

    camLook = viewW * 0.36;
    camX = level.endless
      ? Math.max(0, player.x + player.w / 2 - camLook)
      : clamp(player.x + player.w / 2 - camLook, 0, Math.max(0, level.pixelWidth - viewW));
    prevCam = camX;
    bgTheme = theme;
    bgPrev = theme;
    bgFade = 1;
    acc = 0;
    Sound.speed = 1;
    demoWatch.x = player.x;
    demoWatch.t = 0;
    startWipe('open', 0.55);
    if (session.demo) return; // the attract mode keeps the title music and stays behind the menu

    Sound.startMusic(TRACK_FOR_THEME[theme]);
    if (session.mode === 'endless') showBanner('ENDLESS RUN', 'How far can you go?');
    else showBanner(`STAGE ${session.stage + 1}`, THEME_NAMES[theme]);
    setState('playing');
  }

  function onDeathDone() {
    session.big = false;
    if (session.demo) { loadStage(true); return; }
    if (session.mode === 'endless') { gameOver(); return; }
    session.lives--;
    if (session.lives <= 0) { gameOver(); return; }
    loadStage(true);
  }

  function restartStage() {
    session.score = session.stageStartScore;
    session.coins = session.stageStartCoins;
    if (session.mode === 'endless') { startRun('endless'); return; }
    loadStage(false);
  }

  function stageClear() {
    if (session.demo) {
      startWipe('close', 0.6, () => startDemo(demoStage + 1));
      return;
    }
    session.big = player.big;
    const coinBonus = session.stageCoins * 50;
    const timeBonus = Math.max(0, Math.round(PAR_TIME[session.stage] - session.stageTime)) * 50;
    session.score += coinBonus + timeBonus;
    const isNew = commitHigh();
    const last = session.stage >= STAGE_BUILDERS.length - 1;
    tally = {
      items: [
        { label: 'Flag Bonus', value: session.flagBonus },
        { label: `Coins ×${session.stageCoins}`, value: coinBonus },
        { label: 'Time Bonus', value: timeBonus },
        { label: 'Total Score', value: session.score, total: true }
      ],
      idx: 0, shown: 0, delay: 0.45, tickT: 0, els: []
    };
    const rows = tally.items.map(it => {
      const li = document.createElement('li');
      if (it.total) li.className = 'total';
      const label = document.createElement('span');
      label.textContent = it.label;
      const val = document.createElement('span');
      val.textContent = '0';
      li.append(label, val);
      tally.els.push({ li, val });
      return li;
    });
    $('tally').replaceChildren(...rows);
    $('clear-kicker').textContent = `STAGE ${session.stage + 1} · ${THEME_NAMES[session.stage]}`;
    $('clear-title').textContent = last ? 'All Stages Clear!' : (isNew ? 'Stage Clear — Record!' : 'Stage Clear!');
    $('btn-next').textContent = last ? 'Play Endless ▸' : 'Next Stage ▸';
    setState('clear');
  }

  function updateTally(dt) {
    if (!tally) return;
    if (tally.delay > 0) { tally.delay -= dt; return; }
    if (tally.idx >= tally.items.length) return;
    const it = tally.items[tally.idx];
    const el = tally.els[tally.idx];
    el.li.classList.add('on');
    const rate = Math.max(it.value / 0.7, 400);
    tally.shown = Math.min(it.value, tally.shown + rate * dt);
    el.val.textContent = String(Math.floor(tally.shown));
    tally.tickT -= dt;
    if (tally.tickT <= 0 && it.value > 0) { Sound.play('tick'); tally.tickT = 0.06; }
    if (tally.shown >= it.value) {
      el.val.textContent = String(it.value);
      tally.idx++;
      tally.shown = 0;
      tally.delay = 0.25;
    }
  }

  const tallyDone = () => !tally || tally.idx >= tally.items.length;

  function finishTally() {
    if (!tally) return;
    tally.items.forEach((it, i) => {
      tally.els[i].li.classList.add('on');
      tally.els[i].val.textContent = String(it.value);
    });
    tally.idx = tally.items.length;
  }

  function nextStage() {
    if (session.stage >= STAGE_BUILDERS.length - 1) { startRun('endless'); return; }
    session.stage++;
    loadStage(false);
  }

  function gameOver() {
    Sound.stopMusic();
    Sound.speed = 1;
    Sound.play('gameover');
    const isNew = commitHigh();
    if (session.mode === 'endless' && session.maxDist > bestDistance) {
      bestDistance = session.maxDist;
      Store.save('pixeldash.endless', bestDistance);
    }
    $('over-score').textContent = pad(session.score, 6);
    $('over-best').textContent = String(highScore);
    $('over-detail').textContent = session.mode === 'endless'
      ? `Endless · ${session.maxDist} m (best ${bestDistance} m)`
      : `Stage ${session.stage + 1} · ${THEME_NAMES[session.stage]}`;
    $('over-badge').classList.toggle('show', isNew);
    setState('gameover');
  }

  function toMenu() {
    if (session && !session.demo) commitHigh();
    wipe = null;
    Sound.speed = 1;
    Sound.startMusic('title');
    refreshMenuRecords();
    setState('menu');
    startDemo(demoStage);
  }

  function pauseGame() {
    if (state !== 'playing') return;
    setState('paused');
    Sound.pauseMusic(true);
    Sound.play('pause');
  }

  function resumeGame() {
    if (state !== 'paused') return;
    Sound.unlock();
    setState('playing');
    Sound.pauseMusic(false);
    acc = 0;
  }

  function goRetry() {
    if (!session || session.demo) return;
    const target = session.mode === 'endless' ? 'endless' : session.stage;
    transition(() => startRun(target));
  }
  function goNext() { if (session && !session.demo) transition(nextStage); }
  function goMenu() { transition(toMenu); }

  // ---------- attract-mode pilot ----------
  function demoThink(dt) {
    const p = player, ai = demoAI;
    if (!p || p.state !== 'play') { ai.holdT = 0; ai.held = false; return; }
    const foot = Math.floor((p.y + p.h - 0.01) / TILE);
    const ac = Math.floor((p.dir > 0 ? p.x + p.w + 8 : p.x - 8) / TILE);
    let floor = false;
    for (let r = foot + 1; r < ROWS; r++) if (isSolid(ac, r)) { floor = true; break; }
    const gap = !floor || level.get(ac, 13) === T_LAVA_TOP;
    const wc = Math.floor((p.dir > 0 ? p.x + p.w + 1 : p.x - 1) / TILE);
    const wall = isSolid(wc, foot) && isSolid(wc, foot - 1);
    ai.blockedT = Math.abs(p.x - ai.lastX) < 0.01 && p.onGround ? ai.blockedT + dt : 0;
    ai.lastX = p.x;
    let press = p.onGround && (gap || wall || ai.blockedT > 0.25);
    if (p.wallSliding && !ai.prevWall) ai.holdT = 0;
    if (p.wallSliding && ai.holdT <= 0) press = true;
    ai.prevWall = p.wallSliding;
    // show off a spin at the top of a jump now and then
    if (!press && !p.onGround && !p.spinUsed && !p.wallSliding && Math.abs(p.vy) < 30 && chance(0.01)) press = true;
    if (press) { input.queued = true; ai.holdT = 0.36; }
    ai.held = ai.holdT > 0;
    if (ai.holdT > 0) ai.holdT -= dt;
    // if the pilot gets stuck, roll on to the next stage
    if (p.x > demoWatch.x + 8) { demoWatch.x = p.x; demoWatch.t = 0; }
    else if ((demoWatch.t += dt) > 6 && !wipe) {
      demoWatch.t = -999;
      startWipe('close', 0.6, () => startDemo(demoStage + 1));
    }
  }

  // ===================================================================
  //  UI
  // ===================================================================
  const overlays = { menu: $('menu'), paused: $('pause'), clear: $('clear'), gameover: $('over') };
  const hudEl = $('hud');
  const hudCache = new Map();
  const activePointers = new Set();

  function setJumpPressed(on) {
    if (jumpBtnEl) jumpBtnEl.classList.toggle('pressed', on);
  }

  function updateTouchCue() {
    if (!jumpLblEl || rootEl.dataset.input !== 'touch' || state !== 'playing' || !player) return;
    let cue = 'JUMP';
    if (player.state === 'play') {
      if (player.vaultT > 0 && !player.onGround) cue = 'VAULT';
      else if (player.wallT > 0 && !player.onGround) cue = 'KICK';
      else if (!player.onGround && player.coyote <= 0 && !player.spinUsed && !(player.vy > 0 && nearGround(player))) cue = 'SPIN';
    }
    if (cue !== lastJumpCue) {
      lastJumpCue = cue;
      jumpLblEl.textContent = cue;
    }
  }

  function setState(s) {
    state = s;
    const touchMode = rootEl.dataset.input === 'touch';
    for (const [key, el] of Object.entries(overlays)) {
      const on = key === s;
      el.classList.toggle('show', on);
      el.inert = !on; // hidden panels can't be focused, clicked or read by assistive tech
      el.setAttribute('aria-hidden', String(!on));
      if (on && !touchMode) el.querySelector('.btn.primary')?.focus({ preventScroll: true });
    }
    const activeRun = s !== 'menu' && !!session && !session.demo;
    const prevActive = appEl.dataset.active === 'true';
    appEl.dataset.active = activeRun ? 'true' : 'false';
    hudEl.classList.toggle('hidden', !activeRun);
    if (touchUiEl) {
      const showTouchPad = s === 'playing' && activeRun;
      touchUiEl.classList.toggle('hidden', !showTouchPad);
      touchUiEl.setAttribute('aria-hidden', String(!showTouchPad));
    }
    if (s === 'playing' || s === 'wipe') {
      const a = document.activeElement;
      if (a instanceof HTMLElement && a !== document.body) a.blur();
    }
    keysDown.clear();
    activePointers.clear();
    setJumpPressed(false);
    input.pointer = false;
    input.queued = false;
    if (prevActive !== activeRun) resize();
  }

  function setHud(id, text, pop = false) {
    if (hudCache.get(id) === text) return;
    const had = hudCache.has(id);
    hudCache.set(id, text);
    const el = $(id);
    el.textContent = text;
    if (pop && had && !reduceMotion && typeof el.animate === 'function') {
      el.animate(
        [{ transform: 'scale(1.35)', color: '#ffd23f' }, { transform: 'scale(1)', color: '#ffffff' }],
        { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1.3)' }
      );
    }
  }

  function updateHud() {
    if (!session || session.demo) return;
    const compactStage = rootEl.dataset.device === 'phone' && rootEl.dataset.orientation === 'portrait';
    setHud('hud-score', pad(session.score, 6));
    setHud('hud-coins', `×${pad(session.coins % 100, 2)}`, true);
    setHud('hud-stage', session.mode === 'endless'
      ? `∞${session.maxDist}m`
      : (compactStage ? String(session.stage + 1) : `${session.stage + 1} · ${THEME_NAMES[session.stage].split(' ')[0]}`));
    setHud('hud-lives', session.mode === 'endless' ? '—' : `♥${session.lives}`, true);
    setHud('hud-best', pad(Math.max(highScore, session.score), 6));
    updateTouchCue();
  }

  function showBanner(sub, title) {
    $('banner-sub').textContent = sub;
    $('banner-title').textContent = title;
    $('banner').classList.add('show');
    bannerT = 1.9;
  }

  function refreshMenuRecords() {
    $('menu-high').textContent = String(highScore);
    $('menu-endless').textContent = `${bestDistance} m`;
  }

  const savePrefs = () => Store.save('pixeldash.prefs', prefs);

  function refreshToggles() {
    const setChips = (ids, label, on) => {
      for (const id of ids) {
        const b = $(id);
        b.textContent = `${label}: ${on ? 'On' : 'Off'}`;
        b.classList.toggle('off', !on);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    setChips(['btn-music', 'btn-music-p'], 'Music', Sound.musicOn);
    setChips(['btn-sound', 'btn-sound-p'], 'Sound', Sound.sfxOn);
    setChips(['btn-crt', 'btn-crt-p'], 'CRT', prefs.crt);
    const mute = $('hud-mute');
    mute.classList.toggle('off', Sound.muted);
    mute.textContent = Sound.muted ? '✕' : '♪';
    mute.setAttribute('aria-pressed', String(Sound.muted));
    $('crt').classList.toggle('on', prefs.crt);
  }

  function toggleMusic() {
    Sound.unlock();
    Sound.setMusic(!Sound.musicOn);
    prefs.music = Sound.musicOn;
    savePrefs();
    refreshToggles();
  }
  function toggleSound() {
    Sound.unlock();
    Sound.setSfx(!Sound.sfxOn);
    prefs.sound = Sound.sfxOn;
    savePrefs();
    refreshToggles();
    Sound.play('select');
  }
  function toggleMute() {
    Sound.unlock();
    Sound.setMuted(!Sound.muted);
    refreshToggles();
  }
  function toggleCrt() {
    prefs.crt = !prefs.crt;
    savePrefs();
    refreshToggles();
  }
  const isFullscreenEnabled = () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const getFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function toggleFullscreen() {
    if (!isFullscreenEnabled()) return;
    if (getFullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit === 'function') {
        try { Promise.resolve(exit.call(document)).catch(() => { /* ignore */ }); } catch { /* ignore */ }
      }
      return;
    }
    const el = document.documentElement;
    if (typeof el.requestFullscreen === 'function') {
      try {
        Promise.resolve(el.requestFullscreen({ navigationUI: 'hide' }))
          .catch(() => { try { Promise.resolve(el.requestFullscreen()).catch(() => { /* ignore */ }); } catch { /* ignore */ } });
      } catch {
        try { Promise.resolve(el.requestFullscreen()).catch(() => { /* ignore */ }); } catch { /* ignore */ }
      }
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      try { el.webkitRequestFullscreen(); } catch { /* ignore */ }
    }
  }

  const modeButtons = [...document.querySelectorAll('.mode')];
  function selectMode(i) {
    selectedMode = (i + modeButtons.length) % modeButtons.length;
    modeButtons.forEach((b, k) => {
      b.classList.toggle('selected', k === selectedMode);
      b.setAttribute('aria-checked', String(k === selectedMode));
    });
  }
  function startSelected() {
    if (state !== 'menu') return;
    const mode = modeButtons[selectedMode].dataset.mode;
    const target = mode === 'endless' ? 'endless' : clamp(Number(mode) || 0, 0, STAGE_BUILDERS.length - 1);
    Sound.unlock();
    Sound.play('start');
    transition(() => startRun(target));
  }

  // ---------- stage thumbnails on the mode cards ----------
  function drawThumbScene(g, th, x0, w, detail, withHero) {
    const B = SPR.bg[th];
    const T = SPR.tiles[th];
    g.save();
    g.beginPath();
    g.rect(x0, 0, w, 72);
    g.clip();
    g.drawImage(B.sky, x0, 0, w, 72);
    for (const layer of B.layers) g.drawImage(layer.c, x0 - 24 - th * 40, layer.y - 152);
    if (th > 0) for (let x = x0; x < x0 + w; x += 16) g.drawImage(T.fill, x, -10);
    for (let x = x0; x < x0 + w; x += 16) {
      const lava = detail && th === 2 && x - x0 >= 64 && x - x0 < 96;
      g.drawImage(lava ? SPR.lavaTop[0] : T.top, x, 56);
    }
    if (detail) {
      if (th === 0) {
        g.drawImage(T.brick, x0 + 56, 18);
        g.drawImage(SPR.q[0], x0 + 72, 18);
        g.drawImage(T.brick, x0 + 88, 18);
        g.drawImage(SPR.enemy[0].walk[0], x0 + 100, 40);
      } else if (th === 1) {
        for (const [dx, dy] of [[88, 40], [88, 24], [104, 40], [104, 24]]) g.drawImage(T.hard, x0 + dx, dy);
        for (let i = 0; i < 3; i++) g.drawImage(SPR.coin[0], x0 + 60, 8 + i * 14);
      } else {
        g.drawImage(T.hard, x0 + 40, 26);
        for (let i = 1; i < 5; i++) g.drawImage(SPR.fire[0], x0 + 44 + i * 6, 30 + i * 4);
      }
    }
    if (withHero) g.drawImage(SPR.hero[0][0][th === 1 ? 'jump' : 'run1'][0], x0 + 14, th === 1 ? 30 : 40);
    g.restore();
  }

  function renderThumbs() {
    for (const btn of modeButtons) {
      const g = btn.querySelector('canvas.thumb')?.getContext('2d');
      if (!g) continue;
      g.imageSmoothingEnabled = false;
      if (btn.dataset.mode === 'endless') {
        for (let i = 0; i < 3; i++) drawThumbScene(g, i, i * 43, 43, false, i === 1);
      } else {
        drawThumbScene(g, clamp(Number(btn.dataset.mode) || 0, 0, 2), 0, 128, true, true);
      }
    }
  }

  function bindUI() {
    modeButtons.forEach((b, i) => {
      b.addEventListener('click', () => { selectMode(i); Sound.unlock(); Sound.play('select'); });
      b.addEventListener('dblclick', () => {
        if (rootEl.dataset.input === 'touch') return;
        selectMode(i);
        startSelected();
      });
    });
    const onClick = (id, fn) => $(id).addEventListener('click', fn);
    onClick('btn-start', startSelected);
    onClick('btn-music', toggleMusic);
    onClick('btn-music-p', toggleMusic);
    onClick('btn-sound', toggleSound);
    onClick('btn-sound-p', toggleSound);
    onClick('btn-crt', toggleCrt);
    onClick('btn-crt-p', toggleCrt);
    onClick('btn-resume', resumeGame);
    onClick('btn-restart', () => { if (session && state === 'paused') transition(restartStage); });
    onClick('btn-quit', goMenu);
    onClick('btn-next', () => { if (state === 'clear') goNext(); });
    onClick('btn-clear-menu', goMenu);
    onClick('btn-retry', goRetry);
    onClick('btn-over-menu', goMenu);
    onClick('hud-pause', () => { if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame(); });
    onClick('hud-mute', toggleMute);
    $('tally').addEventListener('click', () => { if (state === 'clear' && !tallyDone()) finishTally(); });
    const hudActions = document.querySelector('.hud-actions');
    if (hudActions) {
      hudActions.addEventListener('pointerdown', e => e.stopPropagation());
      hudActions.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    }
    const full = $('hud-full');
    full.hidden = !isFullscreenEnabled();
    full.addEventListener('click', toggleFullscreen);
    const onFsChange = () => {
      full.setAttribute('aria-pressed', String(!!getFullscreenElement()));
      scheduleResize();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    // never leave focus on a clicked button (Space would re-trigger it mid-game)
    document.addEventListener('click', e => {
      if (e.target instanceof Element) e.target.closest('button')?.blur();
    });
  }

  // ===================================================================
  //  INPUT — keyboard, pointer/touch, gamepad
  // ===================================================================
  const gamepad = { held: false, prev: 0 };
  const PAD_JUMP = 1, PAD_START = 2, PAD_LEFT = 4, PAD_RIGHT = 8;

  function gamepadAction(action) {
    const confirm = action === 'jump' || action === 'start';
    switch (state) {
      case 'playing':
        if (action === 'jump') input.queued = true;
        else if (action === 'start') pauseGame();
        break;
      case 'paused':
        if (confirm) resumeGame();
        break;
      case 'menu':
        if (action === 'left' || action === 'right') {
          selectMode(selectedMode + (action === 'left' ? -1 : 1));
          Sound.play('select');
        } else if (confirm) startSelected();
        break;
      case 'clear':
        if (confirm) { if (tallyDone()) goNext(); else finishTally(); }
        break;
      case 'gameover':
        if (confirm) goRetry();
        break;
      default:
        break;
    }
  }

  function pollGamepad() {
    if (typeof navigator.getGamepads !== 'function') return;
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch {
      return; // blocked by a permissions policy / insecure context
    }
    let gp = null;
    for (const g of pads) if (g?.connected) { gp = g; break; }
    let now = 0;
    if (gp) {
      const btn = i => gp.buttons[i]?.pressed === true;
      const ax = gp.axes[0] ?? 0;
      if (btn(0) || btn(1)) now |= PAD_JUMP;
      if (btn(9)) now |= PAD_START;
      if (btn(14) || ax < -0.6) now |= PAD_LEFT;
      if (btn(15) || ax > 0.6) now |= PAD_RIGHT;
    }
    const pressed = now & ~gamepad.prev;
    gamepad.prev = now;
    gamepad.held = (now & PAD_JUMP) !== 0;
    if (pressed & PAD_JUMP) gamepadAction('jump');
    if (pressed & PAD_START) gamepadAction('start');
    if (pressed & PAD_LEFT) gamepadAction('left');
    if (pressed & PAD_RIGHT) gamepadAction('right');
  }

  function bindInput() {
    const syncInputMode = mode => {
      if (inputOverride === mode) return;
      inputOverride = mode;
      const vp = getViewportSize();
      const prevInput = rootEl.dataset.input;
      applyDeviceProfile(vp.w, vp.h);
      if (prevInput !== rootEl.dataset.input) resize();
    };
    const isInteractiveUI = target => target instanceof Element && !!target.closest('.hud-actions, .overlay, button:not(#btn-jump)');

    window.addEventListener('keydown', e => {
      Sound.unlock();
      if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
      const k = e.code;
      if (JUMP_KEYS.has(k) || k === 'Enter' || k === 'Escape' || k === 'KeyP' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'KeyA' || k === 'KeyD') {
        syncInputMode('desktop');
      }
      const isJump = JUMP_KEYS.has(k);
      const onButton = e.target instanceof HTMLButtonElement;
      if (k === 'KeyM') { toggleMute(); return; }
      if (k === 'KeyN') { toggleMusic(); return; }
      if (k === 'KeyC') { toggleCrt(); return; }
      if (k === 'KeyF') { toggleFullscreen(); return; }
      if (state === 'playing') {
        if (isJump) {
          e.preventDefault();
          if (!e.repeat && !keysDown.has(k)) input.queued = true;
          keysDown.add(k);
          return;
        }
        if (k === 'KeyP' || k === 'Escape') { e.preventDefault(); pauseGame(); }
        return;
      }
      if (state === 'paused') {
        if (k === 'KeyP' || k === 'Escape') { e.preventDefault(); resumeGame(); }
        else if (isJump && !onButton) e.preventDefault();
        return;
      }
      if (state === 'wipe') {
        if (isJump) e.preventDefault();
        return;
      }
      if (onButton && (k === 'Enter' || k === 'Space')) return; // native button activation
      if (state === 'menu') {
        if (k === 'ArrowLeft' || k === 'KeyA') { e.preventDefault(); selectMode(selectedMode - 1); Sound.play('select'); }
        else if (k === 'ArrowRight' || k === 'KeyD') { e.preventDefault(); selectMode(selectedMode + 1); Sound.play('select'); }
        else if (k === 'Enter' || k === 'Space') { e.preventDefault(); startSelected(); }
      } else if (state === 'clear') {
        if (k === 'Enter' || k === 'Space') {
          e.preventDefault();
          if (tallyDone()) goNext(); else finishTally();
        }
      } else if (state === 'gameover') {
        if (k === 'Enter') { e.preventDefault(); goRetry(); }
        else if (k === 'Escape') { e.preventDefault(); goMenu(); }
      }
    });
    window.addEventListener('keyup', e => {
      keysDown.delete(e.code);
      if (state === 'playing' && JUMP_KEYS.has(e.code)) e.preventDefault();
    });

    // Full-viewport touch/click play handler (supports portrait bottom area + #btn-jump + multi-touch)
    appEl.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') syncInputMode('touch');
      else if (e.pointerType === 'mouse') {
        if (e.button !== 0) return;
        syncInputMode('desktop');
      }
      Sound.unlock();
      if (state !== 'playing' || isInteractiveUI(e.target)) return;
      e.preventDefault();
      activePointers.add(e.pointerId);
      input.queued = true;
      input.pointer = true;
      setJumpPressed(true);
      try { appEl.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
    });
    const releasePointer = e => {
      if (!activePointers.delete(e.pointerId)) return;
      input.pointer = activePointers.size > 0;
      setJumpPressed(input.pointer);
    };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    appEl.addEventListener('lostpointercapture', releasePointer);

    // Block iOS Safari long-press callout, selection loupe, double-tap zoom, and pull-to-refresh during gameplay
    appEl.addEventListener('touchstart', e => {
      syncInputMode('touch');
      Sound.unlock();
      if (state === 'playing' && !isInteractiveUI(e.target)) e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', () => Sound.unlock(), { capture: true, passive: true });
    document.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') syncInputMode('touch');
      Sound.unlock();
    }, { capture: true });
    appEl.addEventListener('contextmenu', e => e.preventDefault());
    const blockGesture = e => e.preventDefault();
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });

    const clearInputs = () => {
      keysDown.clear();
      activePointers.clear();
      input.pointer = false;
      setJumpPressed(false);
    };
    window.addEventListener('blur', () => { clearInputs(); pauseGame(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearInputs(); pauseGame(); Sound.sleep(); }
      else { scheduleResize(); Sound.unlock(); }
    });
    window.addEventListener('pagehide', () => { clearInputs(); pauseGame(); Sound.sleep(); });
    window.addEventListener('pageshow', () => { scheduleResize(); Sound.unlock(); });
    window.addEventListener('resize', scheduleResize);
    window.addEventListener('orientationchange', scheduleResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(pointer: coarse)');
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', scheduleResize);
    }
  }

  // ===================================================================
  //  RENDERING
  // ===================================================================
  function drawBackground(theme, cam) {
    const B = SPR.bg[theme];
    ctx.drawImage(B.sky, 0, 0, viewW, VIEW_H);
    for (const layer of B.layers) {
      const w = layer.c.width;
      let off = -((cam * layer.f + worldTime * layer.drift) % w);
      if (off > 0) off -= w;
      for (let x = Math.floor(off); x < viewW; x += w) ctx.drawImage(layer.c, x, layer.y);
    }
  }

  function bumpOffset(cx, cy) {
    for (const b of bumps) {
      if (b.cx === cx && b.cy === cy) return -Math.round(Math.sin((1 - b.t / 0.2) * Math.PI) * 5);
    }
    return 0;
  }

  function drawTiles(cam) {
    const c0 = Math.max(level.offset, Math.floor(cam / TILE));
    const c1 = Math.floor((cam + viewW) / TILE);
    const qf = SPR.q[[0, 0, 0, 1, 2, 1][Math.floor(worldTime * 8) % 6]];
    const coinF = SPR.coin[Math.floor(worldTime * 8) % 4];
    const lavaF = SPR.lavaTop[Math.floor(worldTime * 3) % 2];
    const hasBumps = bumps.length > 0;
    for (let cx = c0; cx <= c1; cx++) {
      const i = cx - level.offset;
      if (i < 0 || i >= level.cols.length) continue;
      const col = level.cols[i];
      const ts = SPR.tiles[level.colTheme[i]];
      const sx = cx * TILE - cam;
      for (let cy = 0; cy < ROWS; cy++) {
        const id = col[cy];
        if (!id) continue;
        let img = null;
        switch (id) {
          case T_GROUND: img = (cy === 0 || col[cy - 1] === T_GROUND) ? ts.fill : ts.top; break;
          case T_BRICK: case T_MBRICK: img = ts.brick; break;
          case T_QCOIN: case T_QBERRY: case T_QSTAR: img = qf; break;
          case T_USED: img = ts.used; break;
          case T_PTL: img = ts.ptl; break;
          case T_PTR: img = ts.ptr; break;
          case T_PBL: img = ts.pbl; break;
          case T_PBR: img = ts.pbr; break;
          case T_HARD: img = ts.hard; break;
          case T_LAVA_TOP: img = lavaF; break;
          case T_LAVA: img = SPR.lava; break;
          case T_COIN: img = coinF; break;
          default: break;
        }
        if (!img) continue;
        const oy = hasBumps ? bumpOffset(cx, cy) : 0;
        ctx.drawImage(img, sx, cy * TILE + oy);
      }
    }
  }

  function drawSprite(img, x, y) { ctx.drawImage(img, Math.round(x), Math.round(y)); }

  function drawText(text, x, y, gold) {
    let cx = Math.round(x);
    const yy = Math.round(y);
    for (const ch of text) {
      const g = SPR.font[ch];
      if (g) ctx.drawImage(g[gold ? 1 : 0], cx, yy);
      cx += 4;
    }
  }

  function heroFrame(p) {
    if (p.state === 'dead') return 'dead';
    if (p.state === 'flag') {
      if (p.flagPhase === 'slide' || p.flagPhase === 'hold') return 'wall';
      if (!p.onGround) return 'jump';
      return ['run1', 'run2', 'run3', 'run2'][Math.floor(p.anim * 12) % 4];
    }
    if (p.skid > 0) return 'skid';
    if (p.wallSliding) return 'wall';
    if (!p.onGround) return 'jump';
    if (Math.abs(p.vx) < 1) return 'stand';
    return ['run1', 'run2', 'run3', 'run2'][Math.floor(p.anim * (p.star > 0 ? 18 : 13)) % 4];
  }

  /** The exact sprite the hero should show this frame (size, palette, pose, facing). */
  function heroImage(p) {
    let big = p.big;
    if (p.growAnim > 0 && Math.floor(p.growAnim * 18) % 2 === 0) big = !big;
    if (p.state === 'dead') big = false;
    const palIdx = p.star > 0 ? 1 + (Math.floor(worldTime * 14) % 3) : 0;
    const set = SPR.hero[big ? 1 : 0][palIdx];
    const pair = set[heroFrame(p)] || set.stand;
    let face = p.dir > 0 ? 0 : 1;
    if (p.state === 'flag' && (p.flagPhase === 'slide' || p.flagPhase === 'hold')) face = 0;
    return pair[face];
  }

  function drawPlayer(alpha, cam) {
    const p = player;
    if (!p || p.hidden) return;
    if (p.invuln > 0 && p.state === 'play' && Math.floor(p.invuln * 20) % 2 === 0) return;
    const img = heroImage(p);
    const x = lerp(p.px, p.x, alpha) - cam + p.w / 2 - 8;
    const y = lerp(p.py, p.y, alpha) + p.h - img.height;
    if (p.spin > 0 && p.state === 'play') {
      const ang = (1 - p.spin / SPIN_TIME) * Math.PI * 4 * p.dir;
      ctx.save();
      ctx.translate(Math.round(x + 8), Math.round(y + img.height / 2));
      ctx.rotate(ang);
      ctx.drawImage(img, -8, -Math.round(img.height / 2));
      ctx.restore();
    } else if (Math.abs(p.sx - 1) > 0.02 || Math.abs(p.sy - 1) > 0.02) {
      // squash & stretch, anchored at the feet
      ctx.save();
      ctx.translate(Math.round(x + 8), Math.round(y + img.height));
      ctx.scale(p.sx, p.sy);
      ctx.drawImage(img, -8, -img.height);
      ctx.restore();
    } else {
      drawSprite(img, x, y);
    }
  }

  function drawGhosts(cam) {
    for (const gh of ghosts) {
      ctx.globalAlpha = clamp(gh.life / 0.24, 0, 1) * 0.45;
      ctx.drawImage(gh.img, Math.round(gh.x - cam), Math.round(gh.y));
    }
    ctx.globalAlpha = 1;
  }

  function drawFlagAndCastle(cam) {
    if (level.castle) {
      const th = level.themeAt(Math.floor(level.castle.x / TILE));
      drawSprite(SPR.castle[th], level.castle.x - cam, 13 * TILE - 80);
    }
    const f = level.flag;
    if (f) {
      const x = Math.round(f.x - cam);
      if (x > -40 && x < viewW + 40) {
        ctx.fillStyle = THEMES[level.themeAt(f.cx)].pole;
        ctx.fillRect(x - 1, f.topY, 2, f.baseY - f.topY);
        ctx.fillStyle = 'rgb(0 0 0 / 0.25)';
        ctx.fillRect(x, f.topY, 1, f.baseY - f.topY);
        drawSprite(SPR.ball, x - 4, f.topY - 8);
        drawSprite(SPR.flag, x - 17, f.flagY);
      }
    }
    if (session && session.mode === 'stage' && level.checkpoint) {
      const x = Math.round(level.checkpoint * TILE + 8 - cam);
      if (x > -20 && x < viewW + 20) {
        let gy = 13 * TILE;
        for (let cy = 2; cy < ROWS; cy++) if (isSolid(level.checkpoint, cy)) { gy = cy * TILE; break; }
        ctx.fillStyle = '#e8e8f0';
        ctx.fillRect(x, gy - 26, 1, 26);
        ctx.fillStyle = session.checkpoint ? '#1fd1bd' : '#8a8a9a';
        ctx.fillRect(x + 1, gy - 26, 9, 6);
        ctx.fillRect(x + 1, gy - 20, 5, 2);
      }
    }
    // endless: dashed marker at your personal best distance
    if (session && session.mode === 'endless' && !session.demo && bestDistance > 0) {
      const x = Math.round(bestDistance * TILE - cam);
      if (x > -30 && x < viewW + 30) {
        ctx.fillStyle = 'rgb(255 210 63 / 0.6)';
        for (let y = 26; y < 13 * TILE; y += 6) ctx.fillRect(x, y, 1, 3);
        drawText('BEST', x - 7, 18, true);
      }
    }
  }

  function drawPowerup(pu, alpha, cam) {
    const img = pu.kind === 'star' ? SPR.star[Math.floor(worldTime * 10) % 2] : SPR.berry;
    drawSprite(img, lerp(pu.px, pu.x, alpha) - cam - 1, lerp(pu.py, pu.y, alpha) - 2);
  }

  function drawParticles(cam) {
    for (const pt of particles) {
      const a = clamp(pt.life / pt.max, 0, 1);
      const sx = Math.round(pt.x - cam), sy = Math.round(pt.y);
      ctx.fillStyle = pt.col;
      if (pt.type === 'brick') {
        ctx.globalAlpha = 1;
        ctx.fillRect(sx - 3, sy - 3, 6, 6);
        ctx.fillStyle = pt.col2;
        ctx.fillRect(sx - 3, sy + 2, 6, 1);
      } else if (pt.type === 'glow') {
        const twinkle = (0.55 + 0.45 * Math.sin(worldTime * 6 + pt.wob)) * Math.min(1, a * 3);
        ctx.globalAlpha = 0.3 * twinkle;
        ctx.fillRect(sx - 1, sy - 1, 3, 3);
        ctx.globalAlpha = twinkle;
        ctx.fillRect(sx, sy, 1, 1);
      } else if (pt.type === 'spark') {
        ctx.globalAlpha = a;
        const s = a > 0.5 ? 2 : 1;
        ctx.fillRect(sx, sy, s, s);
      } else if (pt.type === 'drip') {
        ctx.globalAlpha = a;
        ctx.fillRect(sx, sy, 1, 2);
      } else if (pt.type === 'mote') {
        ctx.globalAlpha = Math.min(1, a * 2) * 0.8;
        ctx.fillRect(sx, sy, 1, 1);
      } else {
        ctx.globalAlpha = a;
        ctx.fillRect(sx, sy, pt.size, pt.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Pixel-crisp iris wipe centred on the hero. */
  function drawWipe(cam, alpha) {
    if (!wipe) return;
    const k = clamp(wipe.t / wipe.dur, 0, 1);
    const ease = k * k * (3 - 2 * k);
    const open = wipe.mode === 'open' ? ease : 1 - ease;
    if (open >= 1) return;
    let cx = viewW / 2, cy = VIEW_H / 2;
    if (player && !player.hidden) {
      cx = clamp(lerp(player.px, player.x, alpha) + player.w / 2 - cam, 24, viewW - 24);
      cy = clamp(lerp(player.py, player.y, alpha) + player.h / 2, 24, VIEW_H - 24);
    }
    const r = (Math.hypot(Math.max(cx, viewW - cx), Math.max(cy, VIEW_H - cy)) + 2) * open;
    ctx.fillStyle = '#05040b';
    for (let y = 0; y < VIEW_H; y++) {
      const dy = y + 0.5 - cy;
      const h2 = r * r - dy * dy;
      if (h2 <= 0) { ctx.fillRect(0, y, viewW, 1); continue; }
      const half = Math.sqrt(h2);
      const l = Math.round(cx - half), rr = Math.round(cx + half);
      if (l > 0) ctx.fillRect(0, y, l, 1);
      if (rr < viewW) ctx.fillRect(rr, y, viewW - rr, 1);
    }
  }

  function render(alpha) {
    ctx.imageSmoothingEnabled = false;
    if (!level) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, viewW, VIEW_H);
      return;
    }
    const cam = Math.round(lerp(prevCam, camX, alpha));
    if (bgFade < 1) {
      drawBackground(bgPrev, cam);
      ctx.globalAlpha = bgFade;
      drawBackground(bgTheme, cam);
      ctx.globalAlpha = 1;
    } else {
      drawBackground(bgTheme, cam);
    }

    // world layer (screen shake applies here, not to the sky)
    ctx.save();
    if (shake > 0.3) ctx.translate(Math.round(rand(-shake, shake)), Math.round(rand(-shake, shake)));

    drawFlagAndCastle(cam);
    // powerups rising out of blocks are drawn behind tiles
    for (const pu of powerups) if (pu.emerge > 0) drawPowerup(pu, alpha, cam);
    drawTiles(cam);
    for (const cp of coinPops) drawSprite(SPR.coin[Math.floor(worldTime * 20) % 4], cp.x - cam, cp.y);
    for (const pu of powerups) if (pu.emerge <= 0) drawPowerup(pu, alpha, cam);

    // firebars
    const ff = SPR.fire[Math.floor(worldTime * 10) % 2];
    for (const fb of level.firebars) {
      const sx = fb.x - cam;
      if (sx < -64 || sx > viewW + 64) continue;
      const ca = Math.cos(fb.ang), sa = Math.sin(fb.ang);
      for (let i = 0; i < fb.len; i++) {
        const r = i * 8;
        drawSprite(ff, sx + ca * r - 4, fb.y + sa * r - 4);
      }
    }

    // enemies
    for (const e of enemies) {
      const set = SPR.enemy[e.theme];
      const x = lerp(e.px, e.x, alpha) - cam - 1;
      const y = lerp(e.py, e.y, alpha) - 2;
      if (e.state === 'squish') {
        drawSprite(set.squish, x, y);
      } else if (e.state === 'flip') {
        ctx.save();
        ctx.translate(Math.round(x + 8), Math.round(y + 8));
        ctx.scale(1, -1);
        ctx.drawImage(set.walk[0], -8, -8);
        ctx.restore();
      } else {
        const img = set.walk[Math.floor(e.anim * 6) % 2];
        if (e.dir > 0) {
          ctx.save();
          ctx.translate(Math.round(x + 16), Math.round(y));
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        } else {
          drawSprite(img, x, y);
        }
      }
    }

    drawGhosts(cam);
    drawPlayer(alpha, cam);
    drawParticles(cam);
    for (const pp of popups) drawText(pp.text, pp.x - cam - pp.text.length * 2, pp.y, pp.gold);
    ctx.restore();

    // star-mode screen shimmer
    if (player && player.star > 0 && state === 'playing') {
      ctx.globalAlpha = 0.06 + 0.04 * Math.sin(worldTime * 20);
      ctx.fillStyle = ['#ff6ad5', '#7af0ff', '#ffe14d'][Math.floor(worldTime * 8) % 3];
      ctx.fillRect(0, 0, viewW, VIEW_H);
      ctx.globalAlpha = 1;
    }
    drawWipe(cam, alpha);
  }

  function renderPreview(t) {
    if (!pctx) return;
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, 96, 32);
    const run = ['run1', 'run2', 'run3', 'run2'][Math.floor(t * 10) % 4];
    pctx.drawImage(SPR.hero[1][0][run][0], 10, 0);
    pctx.drawImage(SPR.coin[Math.floor(t * 8) % 4], 40, 8 + Math.round(Math.sin(t * 4) * 2));
    pctx.drawImage(SPR.enemy[0].walk[Math.floor(t * 6) % 2], 68, 16);
  }

  // ===================================================================
  //  MAIN LOOP — clamped dt, fixed-step simulation, interpolated render
  // ===================================================================
  function simStep(dt) {
    if (hitStop > 0) {
      // freeze-frame: keep interpolation targets still so nothing jitters
      hitStop -= dt;
      prevCam = camX;
      player.px = player.x;
      player.py = player.y;
      for (const e of enemies) { e.px = e.x; e.py = e.y; }
      return;
    }
    input.pressed = input.queued;
    input.queued = false;
    let held;
    if (session.demo) {
      held = demoAI.held;
    } else {
      held = input.pointer || gamepad.held;
      if (!held) for (const k of keysDown) if (JUMP_KEYS.has(k)) { held = true; break; }
    }
    input.held = held;

    worldTime += dt;
    if (shake > 0) shake = Math.max(0, shake - dt * 16);
    if (player.state === 'play') session.stageTime += dt;
    prevCam = camX;
    const s0 = state;
    updatePlayer(dt);
    if (state !== s0) return; // a death / clear handler switched screens
    spawnEnemies();
    updateEnemies(dt);
    updatePowerups(dt);
    updateFirebars(dt);
    collidePlayer();
    updateEffects(dt);
    updateCamera(dt);
    if (session.mode === 'endless') endlessUpdate();
  }

  let lastT = 0;
  function frame(now) {
    window.requestAnimationFrame(frame);
    let dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_DT) dt = MAX_DT;
    try {
      pollGamepad();
      Sound.update();
      if (bannerT > 0) {
        bannerT -= dt;
        if (bannerT <= 0) $('banner').classList.remove('show');
      }
      if (bgFade < 1) bgFade = Math.min(1, bgFade + dt);
      if (state === 'playing' || state === 'wipe' || state === 'menu') updateWipe(dt);

      let alpha = 1;
      if (state === 'playing' || state === 'menu') {
        const s0 = state;
        const demo = s0 === 'menu';
        acc += dt;
        let n = 0;
        while (acc >= STEP && n < MAX_STEPS && state === s0) {
          if (demo) {
            if (!session?.demo) { acc = 0; break; }
            demoThink(STEP);
            Sound.silent = true;
            try { simStep(STEP); } finally { Sound.silent = false; }
          } else {
            simStep(STEP);
          }
          acc -= STEP;
          n++;
        }
        if (n >= MAX_STEPS) acc = 0;
        alpha = state === s0 ? clamp(acc / STEP, 0, 1) : 1;
        if (demo) renderPreview(worldTime);
      } else if (state === 'clear') {
        worldTime += dt;
        updateTally(dt);
      }
      render(alpha);
      updateHud();
    } catch (err) {
      // keep the loop alive, but never flood the console with a repeating error
      if (errorCount++ < 5) console.error('[Pixel Dash]', err);
    }
  }

  // ===================================================================
  //  BOOT
  // ===================================================================
  function boot() {
    if (!ctx) return;
    bakeAll();
    resize();
    renderThumbs();
    bindUI();
    bindInput();
    refreshToggles();
    refreshMenuRecords();
    selectMode(0);
    Sound.startMusic('title'); // starts once audio is unlocked by the first interaction
    setState('menu');
    startDemo(0);
    window.requestAnimationFrame(frame);
  }

  boot();
})();
