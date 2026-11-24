/* Interface do simulador do RU. Usa engine.js (simular, gerarCarga, executar...). */
const $ = id => document.getElementById(id);
const P = { perfil: 'gilbert', servA: 'observado', cen: 'ambos', vel: '2' };
const S = { estado: 'vazio', t: 0, idx: -1, sim: null, carga: null, serie: [], last: 0, tau: TAU, fechar: null, injT: null, cfg: null, res: null };
const BASE = 30; // segundos simulados por segundo real no 1x (hora inteira ≈ 2 min)
const nf = (x, d = 1) => (x == null || !isFinite(x) ? '–' : x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const hhmm = t => { const s = INICIO_COLETA + t; return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };

/* ---------- parâmetros ---------- */
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const g = seg.dataset.g;
  if (g !== 'vel' && S.estado !== 'vazio' && S.estado !== 'concluido') return;
  seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  P[g] = b.dataset.v;
}));
function lerCfg() {
  const seed = parseInt($('inSem').value) || 0, reps = Math.max(2, parseInt($('inRep').value) || 500);
  return { seed, reps, perfil: P.perfil, servA: P.servA, cen: P.cen, modelos: modelosPara(P.servA), keys: chavesReplica(seed, 0) };
}

/* ---------- controle da simulação ao vivo ---------- */
function run(fechar, tau) {
  S.sim = simular(S.carga.carga, S.cfg.modelos, tau, fechar, S.cfg.keys.serv, true);
  S.fechar = fechar; S.tau = tau; S.idx = -1; S.serie = [];
  avancarIdx();
}
function avancarIdx() {
  const sn = S.sim.snaps;
  while (S.idx + 1 < sn.length && sn[S.idx + 1].t <= S.t) { S.idx++; S.serie.push([sn[S.idx].t, sn[S.idx].n]); }
}
function nova() {
  S.cfg = lerCfg();
  S.carga = gerarCarga(S.cfg.keys.carga, S.cfg.perfil);
  S.t = 0; S.injT = null;
  run(S.cfg.cen === 'ambos' ? null : S.cfg.cen, TAU);
}
function tick(now) {
  if (S.estado !== 'rodando') return;
  S.t = Math.min(T, S.t + (now - S.last) / 1000 * BASE * Number(P.vel)); S.last = now;
  avancarIdx(); render();
  if (S.t >= T) setEstado('concluido'); else requestAnimationFrame(tick);
}
function setEstado(e) {
  S.estado = e;
  const nomes = { vazio: 'Vazio', rodando: 'Rodando', pausado: 'Pausado', concluido: 'Concluído' };
  const cores = { vazio: 'lil', rodando: 'verde', pausado: 'ouro', concluido: 'verdeC' };
  $('status').textContent = nomes[e]; $('status').className = 'tag ' + cores[e];
  const trava = e === 'rodando' || e === 'pausado';
  document.querySelectorAll('.seg').forEach(s => s.classList.toggle('lock', trava && s.dataset.g !== 'vel'));
  $('inRep').disabled = $('inSem').disabled = trava;
  $('bIni').textContent = e === 'pausado' ? 'Retomar Simulação' : 'Iniciar Simulação';
  $('bIni').disabled = e === 'rodando'; $('bPau').disabled = e !== 'rodando';
  $('bAva').disabled = !trava; $('bEnc').disabled = e === 'vazio';
  const podeFalha = trava && !(S.fechar && S.t >= S.tau);
  $('fcA').disabled = $('fcB').disabled = !podeFalha;
  $('falhaMsg').textContent = !trava ? 'Inicie a simulação para injetar falhas.'
    : podeFalha ? 'Fechar um atendente congela a admissão nele e migra a fila para o outro.'
    : `${S.fechar} já está fechado. O outro permanece em operação.`;
  document.querySelectorAll('#estados [data-e]').forEach(c => c.classList.toggle('atual', c.dataset.e === e));
  $('bExp').disabled = !(S.res || e === 'concluido');
  render();
}
$('bIni').onclick = () => {
  if (S.estado === 'rodando') return;
  if (S.estado !== 'pausado') nova();
  S.last = performance.now(); setEstado('rodando'); requestAnimationFrame(tick);
};
$('bPau').onclick = () => S.estado === 'rodando' && setEstado('pausado');
$('bAva').onclick = () => {
  if (!S.sim) return;
  S.t = Math.min(T, S.t + 300); avancarIdx();
  if (S.t >= T) setEstado('concluido'); else render();
};
$('bEnc').onclick = () => { S.t = 0; S.idx = -1; S.sim = null; S.serie = []; S.fechar = null; S.injT = null; setEstado('vazio'); };
function injetar(a) {
  if (!S.sim || (S.fechar && S.t >= S.tau)) return;
  S.injT = Math.max(S.t, 0.001); run(a, S.injT); setEstado(S.estado);
}
$('fcA').onclick = () => injetar('A'); $('fcB').onclick = () => injetar('B');

/* ---------- desenho ---------- */
const vazio = { qA: [0], qB: [1, 2], aA: null, aB: null, abA: true, abB: true, n: 3, la: 0, lq: 0, oa: 0, ob: 0, nmax: 3, saidas: 0, migr: 0, cheg: 0, sW: 0, sWq: 0, nW: 0 };
function fila(el, ids) {
  el.innerHTML = ids.slice(0, 12).map(i => `<span class="chip">${i}</span>`).join('') + (ids.length > 12 ? `<span class="chip">+${ids.length - 12}</span>` : '');
  el.classList.toggle('vazia', !ids.length);
}
function atendente(el, nome, st, aberto, t) {
  let cls = 'livre', txt = 'Livre', sub = 'sem aluno';
  if (!aberto) { cls = 'fechado'; txt = 'Fechado'; sub = `ruptura às ${hhmm(S.tau)}`; }
  else if (st && st.fase === 'preparo') { cls = 'preparo'; txt = 'Preparo'; sub = `#${st.id} · inicia em ${Math.max(0, Math.round(st.fim - t))}s`; }
  else if (st) { cls = 'servico'; txt = 'Servindo'; sub = `#${st.id} · ${Math.max(0, Math.round(st.fim - t))}s restantes`; }
  el.className = 'at ' + cls; el.innerHTML = `<span class="mono">Atendente ${nome}</span><strong>${txt}</strong><small>${sub}</small>`;
}
function render() {
  const s = S.sim ? S.sim.snaps[Math.max(S.idx, 0)] : vazio, t = S.t, tt = Math.max(t, 1);
  $('relogio').textContent = hhmm(t); $('minInfo').textContent = `${Math.floor(t / 60)} de 60 min`;
  $('barFill').style.width = (t / T * 100) + '%'; $('barRup').style.left = (S.tau / T * 100) + '%';
  $('rupLab').textContent = `${hhmm(S.tau)} / ${S.fechar ? 'fechamento' : 'ruptura obs.'}`;
  $('chegN').textContent = s.cheg; $('proxId').textContent = s.cheg + 3;
  fila($('qA'), s.qA); fila($('qB'), s.qB);
  $('nA').textContent = `${s.qA.length} na fila`; $('nB').textContent = `${s.qB.length} na fila`;
  atendente($('atA'), 'A', s.aA, s.abA, t); atendente($('atB'), 'B', s.aB, s.abB, t);
  $('migBox').hidden = !(s.migr > 0); $('migTxt').textContent = `${S.fechar === 'B' ? 'B ↓ A' : 'A ↓ B'} → ${s.migr} migrados`;
  const seg = S.carga && S.carga.seg.find(g => t >= g[0] && t < g[1]), r = seg ? seg[3] : 'C';
  $('phC').classList.toggle('dim', r !== 'C'); $('phP').classList.toggle('dim', r !== 'P');
  $('phC').hidden = $('phP').hidden = r === 'J' || r === 'D'; $('phX').hidden = !(r === 'J' || r === 'D');
  $('phX').textContent = r === 'J' ? 'Janelas (sem fases)' : 'Pós-ruptura';
  const pend = s.n, erro = s.saidas + pend - s.cheg - 3;
  const k = [['W', nf(s.nW ? s.sW / s.nW : 0) + ' s', 'tempo no sistema', 'lil'], ['Wq', nf(s.nW ? s.sWq / s.nW : 0) + ' s', 'tempo de espera', ''],
    ['L', nf(s.la / tt, 2), 'média no sistema', ''], ['Lq', nf(s.lq / tt, 2), 'média na fila', ''],
    ['Utilização A', nf(100 * s.oa / tt) + '%', 'tempo em serviço', 'co'], ['Utilização B', nf(100 * s.ob / tt) + '%', 'tempo em serviço', 'vd'],
    ['Nmax', s.nmax, 'pico de pessoas', ''], ['Saídas', s.saidas, 'alunos atendidos', 'vd'], ['Pendentes', pend, 'fila + em atendimento', 'lil'],
    ['Migrados', s.migr, 'transferidos entre filas', 'og'], ['Erro de saldo', erro, `${s.cheg + 3} − ${s.saidas} − ${pend}`, erro === 0 ? 'vd' : 'co']];
  $('kpis').innerHTML = k.map(([a, b, c, cl]) => `<div class="kpi ${cl}"><span>${a}</span><b>${b}</b><small>${c}</small></div>`).join('');
  desenhar();
}
function desenhar() {
  const c = $('chart'), d = devicePixelRatio || 1, w = c.clientWidth, h = 300;
  c.width = w * d; c.height = h * d; const g = c.getContext('2d'); g.scale(d, d);
  const m = { l: 36, r: 16, t: 12, b: 26 }, pw = w - m.l - m.r, ph = h - m.t - m.b;
  const ymax = Math.max(40, Math.ceil((Math.max(...S.serie.map(p => p[1]), 0) + 5) / 10) * 10);
  const X = t => m.l + t / T * pw, Y = n => m.t + ph - n / ymax * ph;
  g.font = '11px Space Mono'; g.fillStyle = '#0F0F12'; g.strokeStyle = '#d8d6d0'; g.lineWidth = 1;
  for (let y = 0; y <= ymax; y += 10) { g.beginPath(); g.moveTo(m.l, Y(y)); g.lineTo(w - m.r, Y(y)); g.stroke(); g.fillText(y, 4, Y(y) + 4); }
  for (let k = 0; k <= 4; k++) g.fillText(hhmm(k * 900), X(k * 900) - 14, h - 6);
  const vline = (t, cor, txt) => { g.strokeStyle = cor; g.lineWidth = 2; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(X(t), m.t); g.lineTo(X(t), m.t + ph); g.stroke(); g.setLineDash([]); g.fillStyle = cor; g.fillText(txt, X(t) + 4, m.t + 10); };
  vline(TAU, '#E1446E', hhmm(TAU) + ' ruptura obs.');
  if (S.injT !== null) vline(S.injT, '#FF7E9C', 'falha injetada');
  if (!S.serie.length) return;
  g.strokeStyle = '#6C4AD0'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(0), Y(S.serie[0][1]));
  let prev = S.serie[0][1];
  for (const [t, n] of S.serie) { g.lineTo(X(t), Y(prev)); g.lineTo(X(t), Y(n)); prev = n; }
  g.lineTo(X(S.t), Y(prev)); g.stroke();
  g.fillStyle = '#0F0F12'; g.fillRect(X(S.t) - 4, Y(prev) - 4, 8, 8);
}
window.addEventListener('resize', desenhar);

/* ---------- abas e resultados (N réplicas × 3 cenários) ---------- */
$('tabSim').onclick = () => { $('tabSim').classList.add('on'); $('tabRes').classList.remove('on'); $('resBox').hidden = true; };
$('tabRes').onclick = () => { $('tabRes').classList.add('on'); $('tabSim').classList.remove('on'); $('resBox').hidden = false; };
$('bRodar').onclick = async () => {
  const cfg = lerCfg(); $('bRodar').disabled = true; $('progTxt').textContent = 'Rodando…';
  S.res = await executar(cfg.reps, cfg.seed, cfg.perfil, cfg.servA, p => { $('progFill').style.width = (p * 100) + '%'; });
  S.resCfg = { replicas: cfg.reps, semente: cfg.seed, perfil: cfg.perfil, servico_a: cfg.servA };
  $('progTxt').textContent = `${cfg.reps} réplicas concluídas`; $('bRodar').disabled = false; $('bExp').disabled = false; resultados();
};
function resultados() {
  const R = S.res, nomes = [['ambos', 'Ambos abertos'], ['fecha_A', 'Fecha A'], ['fecha_B', 'Fecha B']];
  document.querySelector('#tbl tbody').innerHTML = nomes.map(([k, n]) => {
    const r = R[k]; return `<tr><td>${n}</td><td>${nf(r.W_s.media)}</td><td>${nf(r.Wq_s.media)}</td><td>${nf(r.L.media, 2)}</td><td>${nf(r.saidas_T.media)}</td><td><span class="tag ${r.erro_saldo.media === 0 ? 'verde' : 'coral'}">${nf(r.pendentes_T.media)}</span></td></tr>`;
  }).join('');
  const dl = (k, n) => { const d = R[k].delta_W_s; return `<div class="big">+${nf(d.media)} s</div><span class="mono">${n}: IC95% [${nf(d.IC95_inf)}; ${nf(d.IC95_sup)}] · P5–P95 ${nf(d.P5)} a ${nf(d.P95)}</span>`; };
  $('deltaBox').innerHTML = `<span class="mono">ΔW · cenário − ambos abertos</span>${dl('fecha_A', 'Fecha A')}<hr>${dl('fecha_B', 'Fecha B')}`;
  const f = R.fecha_A, rc = RECONSTRUIDO;
  const lin = [['Entradas A/B', f.chegadas.media, rc.chegadas], ['Saídas na hora', f.saidas_T.media, rc.saidas], ['Saldo final', f.pendentes_T.media, rc.saldo], ['Migração A→B', f.migrados.media, rc.migrados], ['População média (L)', f.L.media, rc.L]];
  document.querySelector('#vsBox tbody').innerHTML = lin.map(([n, a, b]) => `<tr><td>${n}</td><td>${nf(a, 1)}</td><td>${nf(b, 1)}</td><td>${(a - b) / b >= 0 ? '+' : ''}${nf((a - b) / b * 100)}%</td></tr>`).join('');
}

/* ---------- exportar JSON ---------- */
$('bExp').onclick = () => {
  const cfg = S.cfg || lerCfg(), s = S.sim ? S.sim.snaps[Math.max(S.idx, 0)] : null;
  const out = { parametros: { T_s: T, tau_s: TAU, n0: N0, pa: PA, lambda_antes: LAM_ANTES, lambda_depois: LAM_DEPOIS, lambda_C: LAM_C, lambda_P: LAM_P, p_CP: P_CP, p_PC: P_PC, modelos: MODELOS },
    replica_ao_vivo: S.sim ? { semente: cfg.seed, perfil: cfg.perfil, servico_a: cfg.servA, cenario: S.fechar || 'ambos', fechamento_s: S.fechar ? S.tau : null, estado_final: s, serie_N_t: S.serie } : null,
    lote: S.res ? { ...S.resCfg, resultados: S.res } : null };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'resultados_ru_web.json'; a.click(); URL.revokeObjectURL(a.href);
};

setEstado('vazio');
