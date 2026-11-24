

const T = 3600.0;
const TAU = 2747.059;                       // última saída válida de A (12h37)
const N0 = { A: 1, B: 2 };
const LAM_ANTES = 285 / (TAU / 60);
const LAM_DEPOIS = 35 / ((T - TAU) / 60);
const PA = 143 / 285;
const LAM_C = 195 / 37, LAM_P = 89 / 8;     // chegadas/min: calma e pico
const P_CP = 6 / 36, P_PC = 6 / 8;          // probabilidades POR MINUTO
const FASE_INICIAL = 0;                     // 0 = calma
const PRIMEIRA_FRONTEIRA = 37.0;
const INICIO_COLETA = 11 * 3600 + 51 * 60 + 23; // 11:51:23 

const MODELOS = {
  A: { w: [0.2907356126698007, 0.7092643873301994],
       mu: [[0.42181926142803, 1.8615769983311712], [2.478835865708627, 2.050515117081235]],
       cov: [[[0.2174778593572225, -0.04240413213877795], [-0.04240413213877795, 0.15222227420395512]],
             [[0.4724348600463364, 0.10427791116833621], [0.10427791116833621, 0.427235182721228]]] },
  B: { w: [0.947869820986479, 0.052130179013521016],
       mu: [[1.7834265389917747, 1.7696059998719775], [2.755029759111803, 2.4563815057958065]],
       cov: [[[1.3297159674634331, 0.016663680435027597], [0.016663680435027597, 0.10254946866326602]],
             [[0.06696760751635734, 0.10941527333730758], [0.10941527333730759, 0.18746326443591435]]] }
};


const RECONSTRUIDO = { chegadas: 320, saidas: 308, saldo: 15, migrados: 7, L: 12.323 };

/* ---------- aleatoriedade com semente (reprodutível) ---------- */
function hash(...a) {
  let h = 2166136261;
  for (const x of a) { h ^= (x | 0) + 0x9e3779b9; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randn = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function knuth(r, l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
function poisson(r, l) { let n = 0; while (l > 20) { n += knuth(r, 20); l -= 20; } return n + (l > 0 ? knuth(r, l) : 0); }

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
  push(v) {
    const a = this.a; a.push(v); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(a[i], a[p]) >= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}


function gerarCarga(seed, perfil) {
  const rf = rng(hash(seed, 1)), rc = rng(hash(seed, 2)), rd = rng(hash(seed, 3));
  const seg = []; 
  if (perfil === 'janelas') {
    seg.push([0, TAU, LAM_ANTES, 'J'], [TAU, T, LAM_DEPOIS, 'D']);
  } else {
    let t = 0, fr = PRIMEIRA_FRONTEIRA, f = FASE_INICIAL;
    while (t < TAU) {
      const fim = Math.min(fr, TAU);
      seg.push([t, fim, f ? LAM_P : LAM_C, f ? 'P' : 'C']);
      if (fim < TAU && rf() < (f ? P_PC : P_CP)) f = 1 - f;
      t = fim; fr += 60;
    }
    seg.push([TAU, T, LAM_DEPOIS, 'D']);
  }
  const carga = [];
  for (const [lo, hi, taxa] of seg) {
    const n = poisson(rc, taxa * (hi - lo) / 60);
    for (let i = 0; i < n; i++) carga.push([lo + (hi - lo) * rc(), rd() < PA ? 'A' : 'B']);
  }
  carga.sort((x, y) => x[0] - y[0]);
  return { carga, seg };
}

/* ---------- ciclos (G,S): mistura de 2 normais em (ln G, ln S) ---------- */
function gerarCiclos(m, n, r) {
  const ch = m.cov.map(c => { const a = Math.sqrt(c[0][0]), b = c[1][0] / a;
    return [a, b, Math.sqrt(c[1][1] - b * b)]; });
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = r(); const j = u < m.w[0] ? 0 : 1;
    const z1 = randn(r), z2 = randn(r), [c00, c10, c11] = ch[j];
    out[i] = [Math.exp(m.mu[j][0] + c00 * z1), Math.exp(m.mu[j][1] + c10 * z1 + c11 * z2)];
  }
  return out;
}

/* ---------- simulação por eventos (duas filas FIFO) ----------
   fechar: null | 'A' | 'B' ; tau: instante do fechamento; rec: grava snapshots p/ animação */
function simular(chegadas, serv, tau, fechar, seed, rec) {
  const total = chegadas.length + 3;
  const rs = [rng(hash(seed, 11)), rng(hash(seed, 12))];
  const ciclos = { A: gerarCiclos(serv.A, total, rs[0]), B: gerarCiclos(serv.B, total, rs[1]) };
  const prox = { A: 0, B: 0 }, aberto = { A: true, B: true };
  let q = { A: [], B: [] }, ativo = { A: null, B: null };
  const H = new Heap(); let serial = 0;
  let la = 0, lq = 0, oa = 0, ob = 0, nmax = 3, pend = 0, saidas = 0, migr = 0, ultimo = 0, cheg = 0, sW = 0, sWq = 0, nW = 0;
  const snaps = [];
  const outro = a => (a === 'A' ? 'B' : 'A');
  const ag = (t, o, tp, v) => H.push([t, o, ++serial, tp, v]);
  const cnt = a => q[a].length + (ativo[a] ? 1 : 0);
  const sv = a => (ativo[a] && ativo[a].fase === 'servico' ? 1 : 0);

  function iniciar(a, t) {
    if (aberto[a] && !ativo[a] && q[a].length) {
      const [id, ent] = q[a].shift();
      const [gap, dur] = ciclos[a][prox[a]++ % total];
      ativo[a] = { id, ent, ini: t + gap, dur, fase: 'preparo', t0: t };
      ag(t + gap, 3, 'inicio', [a, id]);
    }
  }
  function snap(t) {
    if (!rec || t > T) return;
    const st = a => ativo[a] && { id: ativo[a].id, fase: ativo[a].fase,
      fim: ativo[a].fase === 'servico' ? ativo[a].ini + ativo[a].dur : ativo[a].ini };
    snaps.push({ t, qA: q.A.map(x => x[0]), qB: q.B.map(x => x[0]), aA: st('A'), aB: st('B'),
      abA: aberto.A, abB: aberto.B, n: cnt('A') + cnt('B'), la, lq, oa, ob, nmax, saidas, migr, cheg, sW, sWq, nW });
  }

  let cid = 0;
  for (const a of ['A', 'B']) {
    for (let i = 0; i < N0[a]; i++) q[a].push([cid++, null]);
    if (!(a === fechar && tau === 0)) iniciar(a, 0);
  }
  for (const [t, a] of chegadas) ag(t, 2, 'chegada', [cid++, t, a]);
  if (fechar) ag(tau, 1, 'fechar', fechar);
  ag(T, 4, 'fim', null);
  snap(0);

  const esp = [], resp = [];
  while (H.size) {
    const [t, , , tp, v] = H.pop();
    const n = cnt('A') + cnt('B');
    const dt = Math.max(0, Math.min(t, T) - Math.min(ultimo, T));
    la += n * dt; lq += (n - sv('A') - sv('B')) * dt; oa += sv('A') * dt; ob += sv('B') * dt; ultimo = t;

    if (tp === 'saida') {
      const a = v, x = ativo[a];
      if (x.ent !== null) {
        esp.push(x.ini - x.ent); resp.push(t - x.ent);
        if (t <= T) { sW += t - x.ent; sWq += x.ini - x.ent; nW++; }
      }
      ativo[a] = null; if (t <= T) saidas++;
      iniciar(a, t);
    } else if (tp === 'inicio') {
      const [a, id] = v;
      if (!ativo[a] || ativo[a].id !== id) continue;     // início cancelado (cliente migrou)
      ativo[a].fase = 'servico';
      ag(t + ativo[a].dur, 0, 'saida', a);
    } else if (tp === 'chegada') {
      let [id, ent, a] = v;
      if (!aberto[a]) a = outro(a);
      q[a].push([id, ent]); cheg++;
      iniciar(a, t);
    } else if (tp === 'fechar') {
      const a = v, b = outro(a);
      aberto[a] = false;
      if (ativo[a] && ativo[a].fase === 'preparo') { q[a].unshift([ativo[a].id, ativo[a].ent]); ativo[a] = null; }
      migr = q[a].length;
      q[b].push(...q[a]); q[a] = [];
      iniciar(b, t);
    } else if (tp === 'fim') {
      pend = n;
    }
    const atual = cnt('A') + cnt('B');
    if (t <= T) nmax = Math.max(nmax, atual);
    snap(t);
    if (!H.size && atual) throw new Error('Clientes restantes sem evento de conclusão.');
  }
  const media = x => (x.length ? x.reduce((s, y) => s + y, 0) / x.length : NaN);
  return { Wq_s: media(esp), W_s: media(resp), L: la / T, Lq: lq / T, U_A_pct: 100 * oa / T, U_B_pct: 100 * ob / T,
    Nmax: nmax, saidas_T: saidas, pendentes_T: pend, migrados: migr, chegadas: chegadas.length,
    erro_saldo: saidas + pend - chegadas.length - 3, snaps };
}

/* ---------- estatística entre réplicas ---------- */
function resumir(x) {
  x = x.filter(Number.isFinite); const n = x.length;
  if (!n) return { media: null, P5: null, P95: null, IC95_inf: null, IC95_sup: null };
  const m = x.reduce((s, y) => s + y, 0) / n;
  const sd = n > 1 ? Math.sqrt(x.reduce((s, y) => s + (y - m) ** 2, 0) / (n - 1)) : 0;
  const tc = 1.96 + (1.96 ** 3 + 1.96) / (4 * Math.max(n - 1, 1));   // t de Student aproximado
  const e = n > 1 ? tc * sd / Math.sqrt(n) : 0;
  const s = [...x].sort((a, b) => a - b), qt = p => s[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))];
  return { media: m, P5: qt(0.05), P95: qt(0.95), IC95_inf: m - e, IC95_sup: m + e };
}

function modelosPara(servicoA) { return servicoA === 'igual-b' ? { A: MODELOS.B, B: MODELOS.B } : MODELOS; }
function chavesReplica(seed, i) { return { carga: hash(seed, i, 101), serv: hash(seed, i, 202) }; }

/* Executa N réplicas dos 3 cenários em lotes (não trava a tela). */
function executar(replicas, seed, perfil, servicoA, onProgresso) {
  return new Promise(resolve => {
    const modelos = modelosPara(servicoA);
    const saidas = { ambos: [], fecha_A: [], fecha_B: [] };
    let i = 0;
    (function lote() {
      const fim = Math.min(replicas, i + 20);
      for (; i < fim; i++) {
        const k = chavesReplica(seed, i), { carga } = gerarCarga(k.carga, perfil);
        for (const [nome, f] of [['ambos', null], ['fecha_A', 'A'], ['fecha_B', 'B']]) {
          const r = simular(carga, modelos, TAU, f, k.serv, false); saidas[nome].push(r);
        }
      }
      onProgresso && onProgresso(i / replicas);
      if (i < replicas) return setTimeout(lote, 0);
      const out = {};
      for (const [nome, reps] of Object.entries(saidas)) {
        out[nome] = {};
        for (const c of ['W_s', 'Wq_s', 'L', 'Lq', 'U_A_pct', 'U_B_pct', 'Nmax', 'saidas_T', 'pendentes_T', 'migrados', 'chegadas', 'erro_saldo'])
          out[nome][c] = resumir(reps.map(r => r[c]));
        if (nome !== 'ambos') out[nome].delta_W_s = resumir(reps.map((r, j) => r.W_s - saidas.ambos[j].W_s));
      }
      resolve(out);
    })();
  });
}
