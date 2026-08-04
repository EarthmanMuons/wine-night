// Wine Night frontend. Vanilla JS, mobile-first.
// Connects via WebSocket for live updates, falls back to polling.

const app = document.getElementById('app');
const roomBadge = document.getElementById('roomBadge');
const pourBadge = document.getElementById('pourBadge');
const liveStatus = document.getElementById('liveStatus');

const state = {
	room: null, // uppercase room code
	participantId: null, // set after join
	isHost: false,
	phase: null,
	snapshot: null,
	mode: 'numeric', // the participant's chosen input mode
	numericMax: 100,
	draftDirty: false,
	methodDrafts: {},
	activeMethodChanged: false,
	pendingNotes: null,
	presentationStep: null,
};

// ---- persistence (room + identity) -------------------------
// Identity is stored per-TAB (sessionStorage), NOT localStorage, so each tab /
// browser window is an independent voter. This lets a couple share one phone.
const save = (k, v) => {
	try {
		localStorage.setItem('wn_' + k, JSON.stringify(v));
	} catch {}
};
const load = (k, dflt) => {
	try {
		const v = localStorage.getItem('wn_' + k);
		return v ? JSON.parse(v) : dflt;
	} catch {
		return dflt;
	}
};
const saveSession = (k, v) => {
	try {
		sessionStorage.setItem('wn_' + k, JSON.stringify(v));
	} catch {}
};
const loadSession = (k, dflt) => {
	try {
		const v = sessionStorage.getItem('wn_' + k);
		return v ? JSON.parse(v) : dflt;
	} catch {
		return dflt;
	}
};
const removeSession = (k) => {
	try {
		sessionStorage.removeItem('wn_' + k);
	} catch {}
};
const roomSessionKey = (k, room = state.room) => `${k}_${room || 'none'}`;
const saveRoomSession = (k, v, room = state.room) => saveSession(roomSessionKey(k, room), v);
const loadRoomSession = (k, dflt = null, room = state.room) => loadSession(roomSessionKey(k, room), dflt);

function snapshotHeaders(room = state.room) {
	const headers = {};
	const host = loadRoomSession('hostKey', null, room);
	const pid = loadRoomSession('pid', null, room);
	const participantKey = loadRoomSession('participantKey', null, room);
	if (host) headers['X-Host-Key'] = host;
	if (pid && participantKey) {
		headers['X-Participant-Id'] = pid;
		headers['X-Participant-Key'] = participantKey;
	}
	return headers;
}

function restoreRoomIdentity(room = state.room) {
	const hostKey = loadRoomSession('hostKey', null, room);
	state.isHost = Boolean(hostKey && loadRoomSession('isHost', false, room) === true);
	const participantId = loadRoomSession('pid', null, room);
	const participantKey = loadRoomSession('participantKey', null, room);
	state.participantId = participantId && participantKey ? participantId : null;
	const savedMode = loadRoomSession('mode', null, room);
	if (savedMode) state.mode = savedMode;
	state.numericMax = loadRoomSession('numericMax', 100, room);
}
// Room can come from a query param (/?room=X) or a path segment (/X). Case-insensitive.
const ROOM_RE = /^[A-Za-z0-9]{2,8}$/;
const queryRoom = new URLSearchParams(location.search).get('room');
const pathSeg = decodeURIComponent(location.pathname).split('/').filter(Boolean)[0] || '';
const urlRoom = (queryRoom && queryRoom.match(/^[A-Za-z0-9]{2,8}$/)?.[0]) || (ROOM_RE.test(pathSeg) ? pathSeg : '');
if (urlRoom) {
	state.room = urlRoom.toUpperCase();
	const canonicalPath = `/${state.room}`;
	if (location.pathname !== canonicalPath || location.search) history.replaceState(null, '', canonicalPath);
}

// ---- WebSocket / sync -----------------------------------------------------
let ws = null;
let pollTimer = null;

function connect() {
	if (!state.room) return;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(state.room)}`;
	try {
		ws = new WebSocket(url);
		ws.onopen = () => {
			const key = loadRoomSession('hostKey');
			if (key && loadRoomSession('isHost', false) === true) send({ type: 'hostAuth', hostKey: key });
			const pid = state.participantId || loadRoomSession('pid');
			const participantKey = loadRoomSession('participantKey');
			if (pid && participantKey) {
				state.participantId = pid;
				send({ type: 'rejoin', participantId: pid, participantKey });
			}
			clearInterval(pollTimer);
		};
		ws.onmessage = (e) => {
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				return;
			}
			if (msg.type === 'snapshot') applySnapshot(msg.data);
			if (msg.type === 'joined') {
				state.participantId = msg.participantId;
				saveRoomSession('pid', msg.participantId);
			}
			if (msg.type === 'error') showError(msg.error);
		};
		ws.onclose = () => {
			stopPolling();
			startPolling();
			setTimeout(connect, 1500);
		};
		ws.onerror = () => {};
	} catch {
		stopPolling();
		startPolling();
	}
}

function send(obj) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startPolling() {
	if (pollTimer || !state.room) return;
	fetchSnapshot();
	pollTimer = setInterval(fetchSnapshot, 3000);
}
function stopPolling() {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
}
async function fetchSnapshot() {
	if (!state.room) return;
	try {
		const r = await fetch(`/api/snapshot?room=${encodeURIComponent(state.room)}`, { headers: snapshotHeaders() });
		if (r.ok) applySnapshot(await r.json());
	} catch {}
}

async function api(path, body) {
	const headers = { 'content-type': 'application/json' };
	const key = loadRoomSession('hostKey', null, body.room || state.room);
	if (key) headers['X-Host-Key'] = key;
	const r = await fetch(path, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || 'request failed');
	return data;
}

async function participantApi(path, body) {
	const headers = { 'content-type': 'application/json' };
	const room = body.room || state.room;
	const pid = state.participantId || loadRoomSession('pid', null, room);
	const key = loadRoomSession('participantKey', null, room);
	if (pid && key) {
		headers['X-Participant-Id'] = pid;
		headers['X-Participant-Key'] = key;
	}
	const response = await fetch(path, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'request failed');
	return data;
}

async function downloadHostArchive() {
	const key = loadRoomSession('hostKey');
	if (!state.room || !key) throw new Error('Host access is required to download a backup.');
	const response = await fetch(`/api/host/archive?room=${encodeURIComponent(state.room)}`, {
		headers: { 'X-Host-Key': key },
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'Could not create the backup.');
	const date = new Date().toISOString().slice(0, 10);
	const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = blobUrl;
	link.download = `wine-night-${state.room}-${date}.json`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function hostArchiveButton() {
	return `<button class="btn ghost host-archive no-print" id="downloadArchive" type="button">
    <svg class="archive-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3" />
    </svg>
    <span>Download room backup</span>
  </button>`;
}

function wireHostArchiveButton() {
	if (!state.isHost) return;
	onBtn(app, '#downloadArchive', async () => {
		const button = app.querySelector('#downloadArchive');
		if (button) button.disabled = true;
		try {
			await downloadHostArchive();
		} catch (error) {
			showError(error.message);
		} finally {
			if (button) button.disabled = false;
		}
	});
}

async function refreshAfter(action) {
	try {
		await action;
		await fetchSnapshot();
		return true;
	} catch (error) {
		showError(error.message);
		return false;
	}
}

async function joinParticipant(name, mode, numericMax = 100) {
	const response = await fetch('/api/participant/join', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ room: state.room, name, mode, numericMax }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'could not join');
	state.participantId = data.participantId;
	state.mode = mode;
	state.numericMax = numericMax;
	state.methodDrafts = {};
	state.activeMethodChanged = false;
	state.pendingNotes = null;
	saveRoomSession('pid', data.participantId);
	saveRoomSession('participantKey', data.participantKey);
	saveRoomSession('mode', mode);
	saveRoomSession('numericMax', numericMax);
	send({
		type: 'rejoin',
		participantId: data.participantId,
		participantKey: data.participantKey,
	});
	await fetchSnapshot();
}

function applySnapshot(snap) {
	const previousPhase = state.phase;
	state.snapshot = snap;
	if (snap?.viewer) {
		state.isHost = snap.viewer.isHost === true;
		state.participantId = snap.viewer.participantId || null;
	}
	if (snap && snap.event) state.phase = snap.event.phase;
	if (snap?.event?.phase !== 'revealed') state.presentationStep = null;
	if (snap && snap.event) {
		state.room = snap.event.room;
		roomBadge.hidden = false;
		roomBadge.textContent = `Room ${snap.event.room}`;
		roomBadge.setAttribute('aria-label', `Room code ${snap.event.room}`);
		const currentPour = snap.event.phase === 'tasting' ? snap.event.pour : null;
		pourBadge.hidden = !currentPour;
		if (currentPour) pourBadge.textContent = `Wine ${currentPour.wineCode}`;
	}
	const me = snap?.participants?.find((participant) => participant.id === state.participantId);
	if (me?.mode && !state.draftDirty) {
		state.mode = me.mode;
		state.numericMax = me.numericMax || 100;
		saveRoomSession('mode', me.mode);
		saveRoomSession('numericMax', state.numericMax);
	}
	syncCurrentPour(snap);
	if (
		(state.draftDirty || document.activeElement?.id === 'editName') &&
		previousPhase === 'tasting' &&
		snap?.event?.phase === 'tasting' &&
		document.querySelector('#inputArea')
	) {
		return;
	}
	render();
}

// ---- rendering ------------------------------------------------------------
function render() {
	const snap = state.snapshot;
	if (!snap || !snap.exists) return renderLanding();

	// Host sees setup/tasting/revealed admin; guests see join->tasting->results.
	const me = snap.participants?.find((p) => p.id === (state.participantId || loadRoomSession('pid', ''))) || null;
	syncDocumentTitle(me);

	if (snap.event.phase === 'setup') {
		return state.isHost ? renderHostSetup(snap) : renderWaiting(snap);
	}
	if (snap.event.phase === 'tasting') {
		if (!me && !state.isHost) return renderJoin(snap);
		// Both the host and any joined participant get the voting UI; the host also
		// sees admin status at the top.
		return renderTasting(snap, me);
	}
	if (snap.event.phase === 'revealed') return renderResults(snap, me);
}

function syncDocumentTitle(me = null) {
	document.title = state.isHost ? 'Host for Wine Night' : me?.name ? `${me.name} at Wine Night` : 'Wine Night';
}

function showError(msg) {
	let el = document.querySelector('#appError');
	if (!el) {
		el = document.createElement('div');
		el.id = 'appError';
		el.className = 'error app-error';
		el.setAttribute('role', 'alert');
		el.tabIndex = -1;
		app.prepend(el);
	}
	el.textContent = '';
	requestAnimationFrame(() => {
		el.textContent = msg;
		el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
		el.focus({ preventScroll: true });
	});
}

function prefersReducedMotion() {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
}

function setFieldError(input, errorElement, message, focus = false) {
	if (!input || !errorElement) return;
	errorElement.textContent = message;
	errorElement.hidden = false;
	input.setAttribute('aria-invalid', 'true');
	if (errorElement.id) {
		const describedBy = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
		describedBy.add(errorElement.id);
		input.setAttribute('aria-describedby', [...describedBy].join(' '));
	}
	if (focus) {
		input.focus({ preventScroll: true });
		input.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
	}
}

function clearFieldError(input, errorElement) {
	if (!input || !errorElement) return;
	errorElement.hidden = true;
	errorElement.textContent = '';
	input.removeAttribute('aria-invalid');
	if (errorElement.id) {
		const describedBy = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorElement.id);
		if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '));
		else input.removeAttribute('aria-describedby');
	}
}

function requireName(input, errorElement, message = 'Enter your name to join.') {
	if (input.value.trim()) {
		clearFieldError(input, errorElement);
		return true;
	}
	setFieldError(input, errorElement, message, true);
	return false;
}

function announceStatus(message) {
	if (!liveStatus) return;
	liveStatus.textContent = '';
	requestAnimationFrame(() => {
		liveStatus.textContent = message;
	});
}

// ---- helpers --------------------------------------------------------------
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function onBtn(root, selector, fn) {
	const el = root.querySelector(selector);
	if (el) el.addEventListener('click', fn);
}
function syncPillAria(root) {
	root.querySelectorAll('.pill').forEach((pill) => pill.setAttribute('aria-pressed', String(pill.classList.contains('active'))));
}

// ==========================================================================
// LANDING
// ==========================================================================
function renderLanding() {
	syncDocumentTitle();
	roomBadge.hidden = true;
	pourBadge.hidden = true;
	app.innerHTML = `
    <h1>Wine Night</h1>
    <p class="sub">Blind tasting, ranked the fair way. Grab your phone and join the room.</p>

    <div class="card">
      <label class="field">Room code
        <input type="text" id="joinRoom" placeholder="e.g. GRAPE" maxlength="8" value="${esc(state.room || '')}" />
      </label>
      <p id="joinErr" class="field-error" role="alert" hidden></p>
      <button class="btn" id="goJoin">Join room</button>
    </div>

    <div class="card" style="text-align:center">
      <div class="hint">Hosting the night?</div>
      <button class="btn secondary" id="goHost">Start a new night</button>
    </div>
  `;

	onBtn(app, '#goJoin', async () => {
		const roomInput = app.querySelector('#joinRoom');
		const roomError = app.querySelector('#joinErr');
		const room = roomInput.value.trim().toUpperCase();
		if (!room) {
			setFieldError(roomInput, roomError, 'Enter a room code.', true);
			return;
		}
		clearFieldError(roomInput, roomError);
		try {
			const response = await fetch(`/api/snapshot?room=${encodeURIComponent(room)}`, { headers: snapshotHeaders(room) });
			const snap = await response.json();
			if (!response.ok) throw new Error(snap.error || 'Room code is invalid.');
			if (!snap.exists) throw new Error('Room not found.');
			state.room = room;
			restoreRoomIdentity(room);
			history.replaceState(null, '', `/${room}`);
			applySnapshot(snap);
		} catch (e) {
			showError(e.message || "Couldn't reach that room.");
			return;
		}
		connect();
	});

	onBtn(app, '#goHost', () => {
		state.isHost = true;
		app.innerHTML = renderHostCreate();
		const go = async () => {
			const room = app.querySelector('#hostRoom');
			const code = room.value.trim().toUpperCase() || randomCode();
			room.value = code;
			const hostName = app.querySelector('#hostName').value.trim();
			const theme = app.querySelector('#hostTheme').value.trim();
			const pot = Number(app.querySelector('#hostPot').value) || 0;
			try {
				const created = await api('/api/host/create', { room: code, theme, pot, hostName });
				state.room = code;
				state.isHost = true;
				saveRoomSession('isHost', true, code);
				save('hostName', hostName);
				if (created.hostKey) saveRoomSession('hostKey', created.hostKey, code);
				history.replaceState(null, '', `/${code}`);
				connect();
				await fetchSnapshot();
			} catch (e) {
				showError(e.message === 'room already exists' ? 'That code is taken. Try another.' : e.message);
			}
		};
		app.querySelector('#hostCreateGo').addEventListener('click', go);
		app.querySelector('#restoreGo').addEventListener('click', async () => {
			const file = app.querySelector('#restoreFile').files?.[0];
			if (!file) {
				showError('Choose a Wine Night backup file first.');
				return;
			}
			if (file.size > 1024 * 1024) {
				showError('That backup is larger than the 1 MB restore limit.');
				return;
			}
			let archive;
			try {
				archive = JSON.parse(await file.text());
			} catch {
				showError('That file is not valid JSON.');
				return;
			}
			const roomInput = app.querySelector('#restoreRoom');
			const code = roomInput.value.trim().toUpperCase() || randomCode();
			roomInput.value = code;
			try {
				const restored = await api('/api/host/restore', { room: code, archive });
				state.room = code;
				state.isHost = true;
				saveRoomSession('isHost', true, code);
				if (restored.hostKey) saveRoomSession('hostKey', restored.hostKey, code);
				history.replaceState(null, '', `/${code}`);
				connect();
				await fetchSnapshot();
			} catch (error) {
				showError(error.message === 'room already exists' ? 'That code is taken. Try another.' : error.message);
			}
		});
		const demoBtn = app.querySelector('#createDemo');
		if (demoBtn) demoBtn.addEventListener('click', () => createDemoNight({ hostName: app.querySelector('#hostName').value.trim() }));
	});
}

const DEMO_WINES = [
	[1, 'Comet Reserve', 'Stellar Cellars', 24, 'Sam & Alexa'],
	[2, 'Iron Grove', 'Nord House', 18, 'Mina & Ro'],
	[3, 'Velvet Ridge', 'Cote du Nord', 32, 'Pat & Jordan'],
	[4, 'Glass Torch', 'Hammock Rd', 15, 'Lee & Dana'],
	[5, 'Foxglove', 'Fernwood', 20, 'Ivo & Priya'],
	[6, 'Bramble Lot', 'Old Quarry', 26, 'Nina & Wes'],
];
let DEMO_WINE_IDS = [];

async function createDemoNight({ hostName = 'Host' }) {
	try {
		const code = `D${randomCode()}`;
		const created = await api('/api/host/create', { room: code, theme: 'Washington White Blend', pot: 10, hostName });
		state.room = code;
		state.isHost = true;
		saveRoomSession('isHost', true, code);
		save('hostName', hostName);
		if (created.hostKey) saveRoomSession('hostKey', created.hostKey, code);
		history.replaceState(null, '', `/${code}`);
		connect();
		for (const [bag, name, producer, price, broughtBy] of DEMO_WINES) {
			await api('/api/host/wine', { room: code, bagNumber: bag, name, producer, price, broughtBy });
		}
		const snap = await (await fetch(`/api/snapshot?room=${encodeURIComponent(code)}`)).json();
		DEMO_WINE_IDS = snap.wines.map((w) => w.id);
		await api('/api/host/phase', { room: code, phase: 'tasting' });
		const voters = [
			{ name: 'Sam', mode: 'numeric', scores: [92, 84, 78, 60, 40, 30] },
			{ name: 'Mina', mode: 'numeric', scores: [70, 62, 55, 45, 60, 35] },
			{ name: 'Pat', mode: 'ranked', order: [0, 1, 2, 3, 4, 5] },
			{ name: 'Lee', mode: 'top3', order: [3, 1, 0] },
			{ name: 'Ivo', mode: 'numeric', scores: [30, 45, 88, 92, 85, 78] },
			{ name: 'Nina', mode: 'ranked', order: [0, 1, 3, 2, 5, 4] },
		];
		await seedVoters(voters);
		await fetchSnapshot();
	} catch (e) {
		showError('Demo setup failed: ' + e.message);
	}
}

async function seedVoters(voters) {
	for (const v of voters) {
		const joinedResponse = await fetch('/api/participant/join', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ room: state.room, name: v.name, mode: v.mode }),
		});
		const joined = await joinedResponse.json();
		let ratings;
		if (v.scores) {
			ratings = v.scores.map((score, i) => ({ wineId: DEMO_WINE_IDS[i], value: score }));
		} else {
			ratings = v.order.map((idx, rank) => ({ wineId: DEMO_WINE_IDS[idx], value: rank + 1 }));
		}
		const ballotResponse = await fetch('/api/participant/ballot', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-Participant-Id': joined.participantId,
				'X-Participant-Key': joined.participantKey,
			},
			body: JSON.stringify({ room: state.room, mode: v.mode, ratings, notes: [] }),
		});
		if (!ballotResponse.ok) throw new Error('demo ballot failed');
	}
}

function randomCode() {
	const dict = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let s = '';
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	for (const byte of bytes) s += dict[byte % dict.length];
	return s;
}

function renderHostCreate() {
	return `
    <h1>Start a night</h1>
    <p class="sub">Create a room, then add the wines. Everyone else just needs the code.</p>
    <div class="card">
      <label class="field">Room code
        <input type="text" id="hostRoom" maxlength="8" placeholder="leave blank to auto-generate" value="${esc(state.room || '')}" />
      </label>
      <label class="field">Your name (host)
        <input type="text" id="hostName" value="${esc(load('hostName', ''))}" placeholder="e.g. Alex" />
      </label>
      <div class="hint">Shown as the host and used to prefill your name if you join the voting.</div>
      <label class="field">Theme
        <input type="text" id="hostTheme" placeholder="e.g. Washington White Blend" />
      </label>
      <label class="field">Pot ($ per couple)
        <input type="number" id="hostPot" min="0" step="1" value="10" />
      </label>
      <button class="btn" id="hostCreateGo">Create room</button>
      <button class="btn ghost" id="createDemo" style="margin-top:10px">Create demo night (for trying it out)</button>
      <p id="joinErr" class="field-error" role="alert" hidden></p>
    </div>
    <details class="card restore-card">
      <summary>Restore a room backup</summary>
      <p class="hint">Choose a host backup to create a new room. Setup-only backups return to setup. Backups with submitted ballots open as completed results.</p>
      <label class="field">Backup file
        <input type="file" id="restoreFile" accept="application/json,.json" />
      </label>
      <label class="field">New room code
        <input type="text" id="restoreRoom" maxlength="8" placeholder="leave blank to auto-generate" />
      </label>
      <button class="btn secondary" id="restoreGo" type="button">Restore into a new room</button>
      <p class="hint">Private tasting notes and old access keys are not contained in a host backup.</p>
    </details>
  `;
}

// ==========================================================================
// HOST SETUP
// ==========================================================================
function renderHostSetup(snap) {
	const wines = snap.wines || [];
	const usedBags = new Set(wines.map((w) => Number(w.blindCode)));
	let nextBag = 1;
	while (usedBags.has(nextBag)) nextBag++;
	app.innerHTML = `
    <div class="card">
      <div class="sub"><span class="phase-tag">Setup</span></div>
      <h2>${esc(snap.event.theme || 'Wine Night')}</h2>
      ${snap.event.hostName ? `<div class="hint">Hosted by ${esc(snap.event.hostName)}</div>` : ''}
      <div class="hint">${wines.length} wine(s) entered. You can review them here; guests see only Wine numbers until each bottle is revealed.</div>
      <button class="btn secondary" id="showQR" style="margin-top:12px">Share join QR</button>
    </div>

    <form class="card wine-form" id="wineForm" aria-labelledby="wineFormTitle">
      <h2 id="wineFormTitle">Add a wine</h2>
      <div class="hint" id="wineFormHint" style="margin:0 0 8px">Put each bottle in a numbered bag, then record the bag and price.</div>
      <input type="hidden" id="editingWineId" value="" />
      <div class="row tight">
        <input type="number" id="wBag" value="${nextBag}" min="1" step="1" inputmode="numeric" aria-label="Bag number" />
        <input type="number" id="wPrice" placeholder="Price $" min="0" step="1" inputmode="decimal" aria-label="Price" />
      </div>
      <div class="row tight">
        <input type="text" id="wName" placeholder="Wine name" />
        <input type="text" id="wProducer" placeholder="Producer" />
      </div>
      <label class="field">Brought by
        <input type="text" id="wBrought" placeholder="e.g. Alex & Morgan" />
      </label>
      <div class="wine-form-actions">
        <button class="btn" id="saveWine" type="submit">Add wine</button>
        <button class="btn ghost" id="cancelWineEdit" type="button" hidden>Cancel editing</button>
      </div>
    </form>

    ${wines
			.map(
				(w) => `
      <div class="wine-item">
        <div class="blind-badge">${esc(w.blindCode)}</div>
        <div style="flex:1">
          <div>${esc(w.name)}</div>
          <div class="hint">Bag ${esc(w.blindCode)} · ${esc(w.producer)} · \$${esc(w.price)} · ${esc(w.broughtBy)}</div>
        </div>
        <div class="wine-actions">
          <button class="btn ghost" data-editwine="${w.id}" style="margin:0;padding:8px 12px;width:auto" aria-label="Edit bag ${esc(w.blindCode)}" aria-controls="wineForm">✎</button>
          <button class="btn ghost" data-removewine="${w.id}" style="margin:0;padding:8px 12px;width:auto" aria-label="Remove bag ${esc(w.blindCode)}">✕</button>
        </div>
      </div>`,
			)
			.join('')}

    <button class="btn gold" id="startTasting" ${wines.length < 2 ? "disabled style='opacity:.5'" : ''}>
      Start tasting »
    </button>
    <div class="hint" style="text-align:center">The bag number you enter is the code everyone tastes by.</div>
    <div style="text-align:center;margin-top:14px">
      <button class="btn ghost" id="resetAll" style="width:auto;padding:8px 16px">Reset everything</button>
    </div>
    <div class="host-utility-actions no-print">
      ${hostArchiveButton()}
    </div>
  `;

	onBtn(app, '#showQR', () => showJoinQR(state.room));
	wireHostArchiveButton();
	const room = state.room;
	const wineForm = app.querySelector('#wineForm');
	let editReturnFocus = null;
	const resetWineForm = (restoreFocus = false) => {
		const returnFocus = editReturnFocus;
		editReturnFocus = null;
		app.querySelector('#editingWineId').value = '';
		app.querySelector('#wineFormTitle').textContent = 'Add a wine';
		app.querySelector('#wineFormHint').textContent = 'Put each bottle in a numbered bag, then record the bag and price.';
		app.querySelector('#wBag').value = String(nextBag);
		app.querySelector('#wPrice').value = '';
		app.querySelector('#wName').value = '';
		app.querySelector('#wProducer').value = '';
		app.querySelector('#wBrought').value = '';
		app.querySelector('#saveWine').textContent = 'Add wine';
		app.querySelector('#cancelWineEdit').hidden = true;
		wineForm.classList.remove('editing-wine');
		app.querySelectorAll('.wine-item.editing-wine').forEach((item) => item.classList.remove('editing-wine'));
		if (restoreFocus) returnFocus?.focus();
	};

	app.querySelectorAll('[data-editwine]').forEach((btn) =>
		btn.addEventListener('click', () => {
			const wine = wines.find((item) => item.id === btn.dataset.editwine);
			if (!wine) return;
			editReturnFocus = btn;
			app.querySelector('#editingWineId').value = wine.id;
			app.querySelector('#wineFormTitle').textContent = 'Edit wine';
			app.querySelector('#wineFormHint').textContent = `Update Wine ${wine.blindCode}, then save your changes.`;
			app.querySelector('#wBag').value = wine.blindCode;
			app.querySelector('#wPrice').value = wine.price || '';
			app.querySelector('#wName').value = wine.name || '';
			app.querySelector('#wProducer').value = wine.producer || '';
			app.querySelector('#wBrought').value = wine.broughtBy || '';
			app.querySelector('#saveWine').textContent = 'Save changes';
			app.querySelector('#cancelWineEdit').hidden = false;
			wineForm.classList.add('editing-wine');
			app.querySelectorAll('.wine-item').forEach((item) => item.classList.remove('editing-wine'));
			btn.closest('.wine-item')?.classList.add('editing-wine');
			wineForm.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
			app.querySelector('#wName').focus({ preventScroll: true });
		}),
	);
	onBtn(app, '#cancelWineEdit', () => resetWineForm(true));

	app.querySelectorAll('[data-removewine]').forEach((btn) =>
		btn.addEventListener('click', async () => {
			if (!confirm('Remove this wine and its entry?')) return;
			await refreshAfter(api('/api/host/remove-wine', { room, wineId: btn.dataset.removewine }));
		}),
	);

	wineForm.addEventListener('submit', async (event) => {
		event.preventDefault();
		const name = app.querySelector('#wName').value.trim();
		const bag = Number(app.querySelector('#wBag').value);
		if (!name || !bag) {
			showError('Enter a bag number and wine name.');
			return;
		}
		const wineId = app.querySelector('#editingWineId').value;
		const details = {
			room,
			bagNumber: bag,
			name,
			producer: app.querySelector('#wProducer').value.trim(),
			price: Number(app.querySelector('#wPrice').value) || 0,
			broughtBy: app.querySelector('#wBrought').value.trim(),
		};
		const saved = await refreshAfter(wineId ? api('/api/host/edit-wine', { ...details, wineId }) : api('/api/host/wine', details));
		if (!saved) return;
		// The bag is pre-filled with the next number on the re-render; focus the name field to
		// speed up the next entry.
		if (!wineId) {
			setTimeout(() => {
				const n = app.querySelector('#wName');
				if (n) n.focus();
			}, 80);
		}
	});

	onBtn(app, '#resetAll', async () => {
		if (!confirm('Start completely over? This clears wines, participants, and scores.')) return;
		await refreshAfter(api('/api/host/reset', { room, mode: 'all' }));
	});

	onBtn(app, '#startTasting', async () => {
		await refreshAfter(api('/api/host/phase', { room, phase: 'tasting' }));
	});
}

// ==========================================================================
// WAITING / JOIN
// ==========================================================================
function renderWaiting(snap) {
	const theme = snap.event.theme?.trim();
	const host = snap.event.hostName?.trim() || 'the host';
	app.innerHTML = `
    <div class="card" style="text-align:center">
      <h1>${theme ? `Welcome to the ${esc(theme)} wine night!` : 'Welcome to Wine Night!'}</h1>
      <div class="sub">Waiting for ${esc(host)} to finish setup…</div>
      <div class="hint">${(snap.wines || []).length} wine(s) registered</div>
    </div>
  `;
}

function renderJoin(snap) {
	app.innerHTML = `
    <div class="card" style="text-align:center">
      <h1>${esc(snap.event.theme || 'Wine Night')}</h1>
      <div class="sub">${(snap.wines || []).length} wines in play. Tasting is underway.</div>
    </div>
    <div class="card">
      <h2>Join the tasting</h2>
      <div class="hint">Enter your name first. You’ll choose how you want to vote on the next screen.</div>
      <label class="field">Your name
        <input type="text" id="jName" placeholder="e.g. Taylor" />
      </label>
      <p id="joinErr" class="field-error" role="alert" hidden></p>
      <button class="btn" id="joinGo">Join the tasting</button>
    </div>
  `;

	onBtn(app, '#joinGo', async () => {
		const nameInput = app.querySelector('#jName');
		const nameError = app.querySelector('#joinErr');
		if (!requireName(nameInput, nameError)) return;
		const name = nameInput.value.trim();
		save('name', name);
		try {
			const numericMax = Number.isInteger(state.numericMax) && state.numericMax >= 2 && state.numericMax <= 1000 ? state.numericMax : 100;
			await joinParticipant(name, state.mode, numericMax);
		} catch (error) {
			showError(error.message);
		}
	});
	const nameInput = app.querySelector('#jName');
	nameInput.addEventListener('input', () => {
		if (nameInput.value.trim()) clearFieldError(nameInput, app.querySelector('#joinErr'));
	});
}

// ==========================================================================
// TASTING
// ==========================================================================
function tallyCounts(snap) {
	return {
		ballots: snap.progress?.ballotsSubmitted || 0,
		participants: snap.progress?.participantCount || 0,
	};
}

function tastingProgressText(snap, pour) {
	const theme = snap.event.theme?.trim();
	return `Tasting ${pour.position} of ${pour.total}${theme ? ` ${theme} wines` : ' wines'}`;
}

function renderHostTastingStatus(snap) {
	const participants = snap.participants || [];
	const pour = snap.event.pour;
	const wines = snap.wines || [];
	const previousWine = pour ? wines[pour.position - 2] : null;
	const nextWine = pour ? wines[pour.position] : null;
	return `<div id="hostTastingStatus">
    ${
			pour
				? `<div class="pour-panel">
      <div class="section-label">Currently pouring</div>
      <div class="host-pour-wine" data-current-pour-code>Wine ${esc(pour.wineCode)}</div>
      <div class="hint" data-current-pour-position>${esc(tastingProgressText(snap, pour))}. This updates every participant's screen.</div>
      <div class="pour-controls">
        <button class="btn ghost pour-previous" data-set-pour="${esc(previousWine?.id || '')}" ${previousWine ? '' : 'disabled'}>${previousWine ? `← Wine ${esc(previousWine.blindCode)}` : '← Previous'}</button>
        <button class="btn secondary pour-next" data-set-pour="${esc(nextWine?.id || '')}" ${nextWine ? '' : 'disabled'}>${nextWine ? `Next: Wine ${esc(nextWine.blindCode)} →` : 'Final wine'}</button>
      </div>
    </div>`
				: ''
		}
    <div class="ballot-status">
      <div class="section-label">Submitted ballots</div>
      <div class="status-roster">
        ${
					participants.length
						? participants
								.map(
									(participant) => `
          <span class="status-chip ${participant.hasSubmitted ? 'status-done' : 'status-waiting'}">
            ${participant.hasSubmitted ? 'Submitted' : 'Not submitted'}: ${esc(participant.name)}
          </span>`,
								)
								.join('')
						: '<span class="hint">No voters have joined yet.</span>'
				}
      </div>
    </div></div>`;
}

function renderParticipantPourStatus(snap) {
	const pour = snap.event.pour;
	if (!pour) return '';
	return `<div class="card pour-now" id="participantPourStatus" aria-live="polite">
    <div class="section-label">The host is currently pouring</div>
    <div class="pour-wine" data-current-pour-code>Wine ${esc(pour.wineCode)}</div>
    <div class="hint" data-current-pour-position>${esc(tastingProgressText(snap, pour))}</div>
  </div>`;
}

function syncCurrentPour(snap) {
	const pour = snap?.event?.pour;
	if (!pour) return;
	if (snap.event.phase === 'tasting') {
		pourBadge.hidden = false;
		pourBadge.textContent = `Wine ${pour.wineCode}`;
	}
	app.querySelectorAll('[data-current-pour-code]').forEach((element) => {
		element.textContent = `Wine ${pour.wineCode}`;
	});
	app.querySelectorAll('[data-current-pour-position]').forEach((element) => {
		const suffix = element.closest('#hostTastingStatus') ? ". This updates every participant's screen." : '';
		element.textContent = `${tastingProgressText(snap, pour)}${suffix}`;
	});
	const wines = snap.wines || [];
	const previousWine = wines[pour.position - 2];
	const nextWine = wines[pour.position];
	const previousButton = app.querySelector('.pour-previous');
	if (previousButton) {
		previousButton.dataset.setPour = previousWine?.id || '';
		previousButton.disabled = !previousWine;
		previousButton.textContent = previousWine ? `← Wine ${previousWine.blindCode}` : '← Previous';
	}
	const nextButton = app.querySelector('.pour-next');
	if (nextButton) {
		nextButton.dataset.setPour = nextWine?.id || '';
		nextButton.disabled = !nextWine;
		nextButton.textContent = nextWine ? `Next: Wine ${nextWine.blindCode} →` : 'Final wine';
	}
}

function wirePourControl() {
	if (!state.isHost) return;
	app.querySelectorAll('[data-set-pour]').forEach((button) =>
		button.addEventListener('click', async () => {
			if (!button.dataset.setPour) return;
			app.querySelectorAll('[data-set-pour]').forEach((control) => (control.disabled = true));
			const updated = await refreshAfter(
				api('/api/host/current-pour', {
					room: state.room,
					wineId: button.dataset.setPour,
				}),
			);
			if (!updated) syncCurrentPour(state.snapshot);
		}),
	);
}

function draftFromSavedBallot(mode, ratings, wines, numericMax) {
	const wineIds = wines.map((wine) => wine.id);
	if (mode === 'numeric') {
		const values = {};
		for (const wineId of wineIds) {
			if (Number.isFinite(ratings[wineId])) values[wineId] = ratings[wineId];
		}
		return { mode, values, tieOrder: wineIds, numericMax, revision: 0, originMode: mode, originRevision: 0 };
	}
	const ranked = wineIds.filter((wineId) => Number.isFinite(ratings[wineId])).sort((a, b) => ratings[a] - ratings[b]);
	const rankedSet = new Set(ranked);
	const order = [...ranked, ...wineIds.filter((wineId) => !rankedSet.has(wineId))];
	return { mode, order, revision: 0, originMode: mode, originRevision: 0 };
}

function draftRatings(draft) {
	if (!draft) return {};
	if (draft.mode === 'numeric') return { ...draft.values };
	return Object.fromEntries(draft.order.map((wineId, index) => [wineId, index + 1]));
}

function captureBallotDraft(wines, mode, changed = state.activeMethodChanged) {
	const wineIds = wines.map((wine) => wine.id);
	const existing = state.methodDrafts[mode] || {
		mode,
		revision: 0,
		originMode: mode,
		originRevision: 0,
	};
	const revision = existing.revision + (changed ? 1 : 0);
	const metadata = changed
		? { revision, originMode: mode, originRevision: revision }
		: {
				revision,
				originMode: existing.originMode ?? mode,
				originRevision: existing.originRevision ?? revision,
			};
	if (mode === 'numeric') {
		const values = {};
		app.querySelectorAll('.score-input').forEach((input) => {
			if (input.value !== '') values[input.dataset.wine] = Number(input.value);
		});
		return {
			mode,
			values,
			tieOrder: existing.tieOrder?.filter((wineId) => wineIds.includes(wineId)) || wineIds,
			numericMax: state.numericMax,
			...metadata,
		};
	}
	const visibleOrder = [...app.querySelectorAll('#rankList li')].map((item) => item.dataset.wine);
	return { mode, order: visibleOrder.length === wineIds.length ? visibleOrder : wineIds, ...metadata };
}

function convertBallotDraft(source, targetMode, wines) {
	const wineIds = wines.map((wine) => wine.id);
	const previousTarget = state.methodDrafts[targetMode];
	const revision = (previousTarget?.revision ?? -1) + 1;
	const originMode = source.originMode ?? source.mode;
	const originRevision = source.originRevision ?? source.revision;
	const order =
		source.mode === 'numeric'
			? WineNightBallotConversion.orderedWineIdsFromNumeric(source.values, wineIds, source.tieOrder || wineIds)
			: source.order;
	if (targetMode === 'numeric') {
		const rankedCount = source.mode === 'top3' ? Math.min(3, order.length) : order.length;
		return {
			mode: targetMode,
			values: WineNightBallotConversion.proportionalScoresFromOrder(order, rankedCount, state.numericMax),
			tieOrder: order,
			numericMax: state.numericMax,
			revision,
			originMode,
			originRevision,
		};
	}
	return { mode: targetMode, order: [...order], revision, originMode, originRevision };
}

function draftMatchesSavedBallot(draft, mode, savedRatings, wines, savedNumericMax) {
	if (!draft || draft.mode !== mode) return false;
	const wineIds = wines.map((wine) => wine.id);
	if (mode === 'numeric') {
		if (draft.numericMax !== savedNumericMax) return false;
		return wineIds.every((wineId) => (draft.values[wineId] ?? null) === (savedRatings[wineId] ?? null));
	}
	const savedOrder = wineIds
		.filter((wineId) => Number.isFinite(savedRatings[wineId]))
		.sort((left, right) => savedRatings[left] - savedRatings[right]);
	const comparedCount = mode === 'top3' ? Math.min(3, wineIds.length) : wineIds.length;
	return savedOrder.length === comparedCount && savedOrder.every((wineId, index) => draft.order[index] === wineId);
}

function captureDraftNotes() {
	const fields = [...app.querySelectorAll('.note-input')];
	if (!fields.length) return state.pendingNotes;
	return Object.fromEntries(fields.map((input) => [input.dataset.noteWine, input.value]));
}

function notesMatchSaved(notes, savedNotes, wines) {
	if (!notes) return true;
	return wines.every((wine) => (notes[wine.id] || '').trim() === (savedNotes[wine.id] || '').trim());
}

function conversionNotice(sourceMode, targetMode, restored) {
	if (restored) return `Your earlier ${targetMode === 'numeric' ? 'numeric scores' : 'wine order'} was restored because the converted version was not edited.`;
	if (sourceMode === 'numeric') {
		return 'Converted from your numeric scores. Equal or blank scores keep their previous wine order. Your submitted ballot changes only when you submit this version.';
	}
	if (targetMode === 'numeric') {
		return `Converted proportionally from your ranking to the 1 to ${state.numericMax} scale. A small scale may produce tied scores. Your exact order is kept if you switch back before editing.`;
	}
	return 'Your wine order was kept. Your submitted ballot changes only when you submit this version.';
}

function renderTasting(snap, me) {
	const wines = snap.wines || [];
	const mode = state.mode;
	const savedMine = (me && snap.ratings && snap.ratings[me.id]) || {};
	if (me && !state.methodDrafts[mode] && me.mode === mode) {
		state.methodDrafts[mode] = draftFromSavedBallot(mode, savedMine, wines, me.numericMax || state.numericMax);
	}
	if (!state.methodDrafts[mode]) state.methodDrafts[mode] = draftFromSavedBallot(mode, {}, wines, state.numericMax);
	if (mode === 'numeric' && state.methodDrafts[mode].numericMax) {
		state.numericMax = state.methodDrafts[mode].numericMax;
		saveRoomSession('numericMax', state.numericMax);
	}
	const mine = draftRatings(state.methodDrafts[mode]);
	const ballotIsSubmitted = me?.mode === mode && Object.keys(savedMine).length > 0 && !state.draftDirty;
	const counts = state.isHost ? tallyCounts(snap) : null;

	let admin = '';
	if (state.isHost) {
		admin = `
      <div class="card">
        <div class="sub"><span class="phase-tag">Tasting</span> · ${(snap.participants || []).length} joined</div>
        <h2>${esc(snap.event.theme || 'Wine Night')}</h2>
        ${snap.event.hostName ? `<div class="hint">Hosted by ${esc(snap.event.hostName)}</div>` : ''}
        ${
					counts
						? `
        <div class="bstats"><span>Wines</span><strong>${(snap.wines || []).length}</strong></div>
        <div class="bstats"><span>Submitted ballots</span><strong>${counts.ballots}</strong></div>
        <div class="bstats"><span>Waiting to submit</span><strong>${Math.max(0, counts.participants - counts.ballots)}</strong></div>`
						: ''
				}
        ${renderHostTastingStatus(snap)}
        <button class="btn secondary" id="showQR" style="margin-top:8px">Share join QR</button>
        <button class="btn gold" id="reveal">Reveal results</button>
        <button class="btn ghost" id="backToSetup" style="width:auto;padding:8px 14px;margin:10px auto 0">Back to setup</button>
      </div>`;
	}

	app.innerHTML = `
    ${admin}
    ${me && !state.isHost ? renderParticipantPourStatus(snap) : ''}
    ${
			me
				? `
      <div class="card voter-card" id="modeSwitch">
        <div class="sub"><span class="phase-tag">Vote</span></div>
        <div class="ballot-title-row">
          <h2><span id="ballotOwner">${esc(me.name)}</span>’s ballot</h2>
          <button class="edit-name-toggle" id="editNameToggle" type="button" aria-label="Edit the name on this ballot" aria-expanded="false" aria-controls="nameEditor">
            <svg class="edit-name-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" />
            </svg>
          </button>
        </div>
        <div class="name-editor" id="nameEditor" hidden>
          <div class="hint">Correct your name here if you notice a typo.</div>
          <div class="voter-identity">
            <input type="text" id="editName" value="${esc(me.name)}" maxlength="40" aria-label="Name on your ballot" />
            <button class="btn" id="saveName" type="button">Save</button>
            <button class="btn ghost" id="cancelNameEdit" type="button">Cancel</button>
          </div>
          <p id="editNameErr" class="field-error" role="alert" hidden></p>
        </div>
        <div class="hint">Rate each wine blind. You can update any time before the reveal.</div>
        <div class="voting-method-choice">
          <h3>Choose how you want to vote</h3>
          <div class="hint">Use whichever method feels most natural. All three methods count equally.</div>
          <div class="pill-group">
            <button type="button" class="pill ${mode === 'numeric' ? 'active' : ''}" data-mode="numeric" aria-controls="methodDetails">Numeric</button>
            <button type="button" class="pill ${mode === 'ranked' ? 'active' : ''}" data-mode="ranked" aria-controls="methodDetails">Full rank</button>
            <button type="button" class="pill ${mode === 'top3' ? 'active' : ''}" data-mode="top3" aria-controls="methodDetails">Top 3</button>
          </div>
          ${renderVotingMethodDetails(mode)}
        </div>
      </div>
      <div class="card" id="inputArea"></div>
      ${state.isHost ? `<div class="host-voting-settings"><button class="leave-voting" id="leaveVoting">Stop voting as ${esc(me.name)}</button></div>` : ''}
    `
				: `
      <div class="card">
        <div class="sub"><span class="phase-tag">Vote</span></div>
        <h2>Join the voting</h2>
        <div class="hint">Enter your name first. You’ll choose how you want to vote on the next screen without changing any host controls.</div>
        <label class="field">Your name
          <input type="text" id="vName" value="${esc((state.isHost ? snap.event.hostName : '') || load('name') || '')}" placeholder="e.g. Taylor" />
        </label>
        <p id="voteJoinErr" class="field-error" role="alert" hidden></p>
        <button class="btn" id="joinVote">Join & vote</button>
      </div>
    `
		}
  `;

	syncPillAria(app);

	// Wire up host reveal/back buttons.
	if (state.isHost) {
		onBtn(app, '#reveal', async () => {
			const waiting = Math.max(0, (snap.progress?.participantCount || 0) - (snap.progress?.ballotsSubmitted || 0));
			const warning = waiting ? ` ${waiting} joined participant${waiting === 1 ? ' has' : 's have'} not submitted a ballot.` : '';
			if (!confirm(`Lock scoring and begin the staged reveal?${warning}`)) return;
			await refreshAfter(api('/api/host/phase', { room: state.room, phase: 'revealed' }));
		});
		onBtn(app, '#showQR', () => showJoinQR(state.room));
		onBtn(app, '#backToSetup', async () => {
			if (!confirm("Go back to setup? This clears everyone's scores so you can edit the wines.")) return;
			await refreshAfter(api('/api/host/reset', { room: state.room, mode: 'setup' }));
		});
	}

	const wireModePills = (container) => {
		container.querySelectorAll('.pill').forEach((p) =>
			p.addEventListener('click', () => {
				const next = p.dataset.mode;
				if (next === state.mode) return;
				if (state.mode === 'numeric') {
					const scaleInput = app.querySelector('#ballotNumericMax');
					const invalidScore = [...app.querySelectorAll('.score-input')].find((input) => !validateNumericScore(input));
					if (!validateNumericMaximum(scaleInput) || invalidScore) {
						const invalid = invalidScore || scaleInput;
						const errorElement = invalid.closest('.score-entry, .scale-entry')?.querySelector('.field-error');
						setFieldError(invalid, errorElement, errorElement?.textContent || 'Check this value.', true);
						return;
					}
				}
				const sourceMode = state.mode;
				const sourceChanged = state.activeMethodChanged;
				const source = captureBallotDraft(wines, sourceMode, sourceChanged);
				state.methodDrafts[sourceMode] = source;
				state.pendingNotes = captureDraftNotes();
				const cachedTarget = state.methodDrafts[next];
				const restoreCached =
					!sourceChanged &&
					cachedTarget &&
					source.originMode === next &&
					source.originRevision === cachedTarget.revision;
				state.methodDrafts[next] = restoreCached ? cachedTarget : convertBallotDraft(source, next, wines);
				state.mode = next;
				state.activeMethodChanged = false;
				const conversionAnnouncement = conversionNotice(sourceMode, next, restoreCached);
				const targetMatchesSaved =
					me?.mode === next &&
					draftMatchesSavedBallot(state.methodDrafts[next], next, savedMine, wines, me.numericMax || state.numericMax);
				state.draftDirty = !(targetMatchesSaved && notesMatchSaved(state.pendingNotes, snap.notes || {}, wines));
				saveRoomSession('mode', next);
				render();
				requestAnimationFrame(() => app.querySelector(`[data-mode="${next}"]`)?.focus());
				announceStatus(conversionAnnouncement);
			}),
		);
	};

	if (!me) {
		onBtn(app, '#joinVote', async () => {
			const nameInput = app.querySelector('#vName');
			const nameError = app.querySelector('#voteJoinErr');
			if (!requireName(nameInput, nameError, 'Enter your name to vote.')) return;
			const name = nameInput.value.trim();
			save('name', name);
			try {
				const numericMax = Number.isInteger(state.numericMax) && state.numericMax >= 2 && state.numericMax <= 1000 ? state.numericMax : 100;
				await joinParticipant(name, state.mode, numericMax);
			} catch (error) {
				showError(error.message);
			}
		});
		const nameInput = app.querySelector('#vName');
		nameInput.addEventListener('input', () => {
			if (nameInput.value.trim()) clearFieldError(nameInput, app.querySelector('#voteJoinErr'));
		});
	} else {
		wireModePills(app.querySelector('#modeSwitch'));
		renderBallotInputs(app, wines, mode, mine, state.pendingNotes || snap.notes || {}, ballotIsSubmitted);
		app.querySelectorAll('[data-submit-ballot]').forEach((button) => button.addEventListener('click', () => submitCurrent(wines, mode)));
		const nameEditor = app.querySelector('#nameEditor');
		const nameToggle = app.querySelector('#editNameToggle');
		onBtn(app, '#editNameToggle', () => {
			nameEditor.hidden = false;
			nameToggle.setAttribute('aria-expanded', 'true');
			const input = app.querySelector('#editName');
			input.focus();
			input.select();
		});
		onBtn(app, '#cancelNameEdit', () => {
			app.querySelector('#editName').value = me.name;
			clearFieldError(app.querySelector('#editName'), app.querySelector('#editNameErr'));
			nameEditor.hidden = true;
			nameToggle.setAttribute('aria-expanded', 'false');
			nameToggle.focus();
		});
		onBtn(app, '#saveName', async () => {
			const input = app.querySelector('#editName');
			const errorElement = app.querySelector('#editNameErr');
			if (!requireName(input, errorElement, 'Enter the name to show on your ballot.')) return;
			const n = input.value.trim();
			save('name', n);
			try {
				await participantApi('/api/participant/rename', { room: state.room, name: n });
				me.name = n;
				syncDocumentTitle(me);
				app.querySelector('#ballotOwner').textContent = n;
				const leaveVoting = app.querySelector('#leaveVoting');
				if (leaveVoting) leaveVoting.textContent = `Stop voting as ${n}`;
				nameEditor.hidden = true;
				nameToggle.setAttribute('aria-expanded', 'false');
				nameToggle.focus();
				announceStatus(`Name updated to ${n}.`);
			} catch (error) {
				showError(error.message);
			}
		});
		const editNameInput = app.querySelector('#editName');
		editNameInput.addEventListener('input', () => {
			if (editNameInput.value.trim()) clearFieldError(editNameInput, app.querySelector('#editNameErr'));
		});
		if (state.isHost) {
			onBtn(app, '#leaveVoting', async () => {
				if (
					!confirm(
						`Stop voting as ${me.name}? This removes only your ballot and private notes. The room and everyone else's vote stay unchanged.`,
					)
				)
					return;
				try {
					await participantApi('/api/participant/leave', { room: state.room });
					removeSession(roomSessionKey('pid'));
					removeSession(roomSessionKey('participantKey'));
					state.participantId = null;
					state.draftDirty = false;
					state.methodDrafts = {};
					state.activeMethodChanged = false;
					state.pendingNotes = null;
					await fetchSnapshot();
				} catch (error) {
					showError(error.message);
				}
			});
		}
	}
	wirePourControl();
}

function renderVotingMethodDetails(mode) {
	if (mode === 'numeric') {
		const numericMax = state.numericMax || 100;
		return `
      <div class="method-details numeric-method-settings" id="methodDetails" aria-live="polite">
        <div class="method-detail-copy">
          <strong>Score each wine</strong>
          <div class="hint">Choose the highest possible score, then score as many wines as you can. Blank wines are tied below the wines you score.</div>
        </div>
        <div class="scale-entry">
          <div class="scale-control"><span>Scores run from 1 to</span><input type="number" id="ballotNumericMax" min="2" max="1000" step="1" value="${esc(numericMax)}" inputmode="numeric" aria-label="Highest possible score" /></div>
          <p class="field-error scale-error" id="ballotNumericMaxError" role="alert" hidden></p>
        </div>
      </div>`;
	}
	if (mode === 'top3') {
		return `
      <div class="method-details" id="methodDetails" aria-live="polite">
        <strong>Choose only your three favorites</strong>
        <div class="hint">Drag them above the Unranked wines divider. All remaining wines are tied. You can also use the arrow buttons.</div>
      </div>`;
	}
	return `
    <div class="method-details" id="methodDetails" aria-live="polite">
      <strong>Put every wine in order</strong>
      <div class="hint">Drag your favorite to 1st Place and your least favorite to Last Place. You can also use the arrow buttons.</div>
    </div>`;
}

function renderBallotInputs(root, wines, mode, mine, notes, ballotIsSubmitted) {
	const area = root.querySelector('#inputArea');
	if (!area) return;
	if (mode === 'numeric') {
		const numericMax = state.numericMax || 100;
		area.innerHTML =
			`
      <div class="numeric-list">` +
			wines
				.map((w, index) => {
					const v = mine[w.id];
					return `
      <div class="score-row">
        <label for="score-${esc(w.id)}" class="score-wine">
          <strong>Wine ${esc(w.blindCode)}</strong>
          <span class="score-range">Score 1 to ${esc(numericMax)}</span>
        </label>
        <div class="score-entry">
          <div class="score-control">
            <input id="score-${esc(w.id)}" class="score-input" type="number" min="1" max="${esc(numericMax)}" data-wine="${w.id}" data-wine-code="${esc(w.blindCode)}" value="${v != null ? esc(v) : ''}" placeholder="Score" inputmode="numeric" enterkeyhint="${index === wines.length - 1 ? 'done' : 'next'}" aria-label="Score Wine ${esc(w.blindCode)} from 1 to ${esc(numericMax)}" />
            <span class="score-denominator">/ ${esc(numericMax)}</span>
          </div>
          <p class="field-error score-error" id="score-error-${esc(w.id)}" role="alert" hidden></p>
        </div>
      </div>`;
				})
				.join('') +
			'</div>';
	} else if (mode === 'ranked' || mode === 'top3') {
		const hasExisting = wines.some((w) => mine[w.id] != null);
		const ordered =
			hasExisting ? [...wines].sort((a, b) => (mine[a.id] ?? 999) - (mine[b.id] ?? 999)) : wines;
		const rankCount = mode === 'top3' ? Math.min(3, ordered.length) : ordered.length;
		const list = ordered
			.map(
				(w, i) => `
        <li class="${mode === 'top3' ? (i < rankCount ? 'ranked-choice' : `unranked-choice ${i === rankCount ? 'unranked-start' : ''}`) : ''}" data-wine="${w.id}" data-pos="${i + 1}">
          <span class="drag-handle" aria-label="Drag Wine ${esc(w.blindCode)}" draggable="true">⠿</span>
          <div class="rank-pos">${mode === 'top3' && i >= rankCount ? 'Unranked' : `${ordinal(i + 1)} Place`}</div>
          <span class="wine-number" data-rank-wine>Wine ${esc(w.blindCode)}</span>
          <button class="rank-up" aria-label="Move Wine ${esc(w.blindCode)} up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="rank-down" aria-label="Move Wine ${esc(w.blindCode)} down" ${i === ordered.length - 1 ? 'disabled' : ''}>▼</button>
        </li>`,
			)
			.join('');
		area.innerHTML = `
      <ol class="rank-list" id="rankList" data-mode="${mode}" data-rank-count="${rankCount}">${list}</ol>`;
		// HTML5 drag-and-drop (desktop + some touch browsers).
		const ol = area.querySelector('#rankList');
		ol.querySelectorAll('li').forEach((item) => item.removeAttribute('draggable'));
		ol.addEventListener('dragstart', (e) => {
			const li = e.target.closest('li');
			if (!li) return;
			e.dataTransfer.setData('text/plain', li.dataset.wine);
			li.classList.add('dragging');
			ol.dataset.dragFrom = li.dataset.wine;
			const ghost = createRankDragGhost(li);
			e.dataTransfer.setDragImage(ghost, 28, 24);
			setTimeout(() => ghost.remove(), 0);
		});
		ol.addEventListener('dragend', (e) => {
			ol.querySelectorAll('.dragging, .drag-over').forEach((item) => item.classList.remove('dragging', 'drag-over'));
			delete ol.dataset.dragFrom;
			refreshRankLabels(ol);
		});
		ol.addEventListener('dragover', (e) => {
			e.preventDefault();
			ol.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
			e.target.closest('li')?.classList.add('drag-over');
		});
		ol.addEventListener('dragleave', (e) => e.target.closest('li')?.classList.remove('drag-over'));
		ol.addEventListener('drop', (e) => {
			e.preventDefault();
			const from = ol.dataset.dragFrom;
			const target = e.target.closest('li');
			if (!from || !target) return;
			const fromLi = ol.querySelector(`li[data-wine="${from}"]`);
			const targetLi = e.target.closest('li');
			if (!fromLi || !targetLi || fromLi === targetLi) return;
			moveWineToSlot(fromLi, targetLi);
			ol.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
			refreshRankLabels(ol);
		});
		// Pointer-based drag for touch (no native DnD).
		enablePointerDrag(ol);
		area.querySelectorAll('.rank-up').forEach((b) => b.addEventListener('click', () => moveRankWine(b.closest('li'), -1)));
		area.querySelectorAll('.rank-down').forEach((b) => b.addEventListener('click', () => moveRankWine(b.closest('li'), 1)));
	}

	area.insertAdjacentHTML(
		'beforeend',
		`<div class="ballot-submit-primary">
      <button class="btn" id="submitRatings" type="button" data-submit-ballot="primary">${ballotIsSubmitted ? 'Update my ballot' : 'Submit my ballot'}</button>
      <div class="ballot-confirmation" id="saveStatus" role="status" aria-live="polite" ${ballotIsSubmitted ? '' : 'hidden'}>
        <svg class="confirmation-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m5 12 4 4L19 6" />
        </svg>
        <div>
          <strong>Ballot submitted</strong>
          <span>Your ratings are in. Scores stay hidden and tasting notes remain private. You can update your ballot before the reveal.</span>
        </div>
      </div>
    </div>`,
	);

	area.insertAdjacentHTML(
		'beforeend',
		`<div class="notes-section">
      <h3>Private tasting notes</h3>
      <div class="hint">Only you can see these. They remain attached to each wine after the reveal.</div>
      ${wines
				.map(
					(wine) => `<label class="field">Wine ${esc(wine.blindCode)}
            <textarea class="note-input" data-note-wine="${wine.id}" maxlength="1000" rows="2" placeholder="Aromas, body, finish, food pairing…">${esc(notes[wine.id] || '')}</textarea>
          </label>`,
				)
				.join('')}
      <button class="btn secondary notes-submit" type="button" data-submit-ballot="notes">${ballotIsSubmitted ? 'Update ballot and notes' : 'Submit ballot and notes'}</button>
    </div>`,
	);
	const scaleInput = root.querySelector('#ballotNumericMax');
	if (scaleInput) {
		scaleInput.addEventListener('input', () => {
			state.draftDirty = true;
			state.activeMethodChanged = true;
			const status = root.querySelector('#saveStatus');
			if (status) status.hidden = true;
			const maximum = Number(scaleInput.value);
			if (Number.isInteger(maximum) && maximum >= 2 && maximum <= 1000) {
				clearFieldError(scaleInput, root.querySelector('#ballotNumericMaxError'));
				state.numericMax = maximum;
				saveRoomSession('numericMax', maximum);
				area.querySelectorAll('.score-input').forEach((input) => {
					input.max = String(maximum);
					input.setAttribute('aria-label', `Score Wine ${input.dataset.wineCode} from 1 to ${maximum}`);
				});
				area.querySelectorAll('.score-range').forEach((label) => label.replaceChildren(`Score 1 to ${maximum}`));
				area.querySelectorAll('.score-denominator').forEach((label) => label.replaceChildren(`/ ${maximum}`));
				area.querySelectorAll('.score-input').forEach((input) => validateNumericScore(input));
			}
		});
		scaleInput.addEventListener('blur', () => validateNumericMaximum(scaleInput));
	}
	area.querySelectorAll('.score-input').forEach((input) => {
		input.addEventListener('keydown', (event) => {
			if (event.key.length === 1 && !/^\d$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
				event.preventDefault();
				showNumericFormatError(input);
			}
		});
		input.addEventListener('beforeinput', (event) => {
			if (event.inputType?.startsWith('insert') && event.data && !/^\d+$/.test(event.data)) {
				event.preventDefault();
				showNumericFormatError(input);
			}
		});
		input.addEventListener('paste', (event) => {
			const pasted = event.clipboardData?.getData('text') || '';
			if (pasted && !/^\d+$/.test(pasted)) {
				event.preventDefault();
				showNumericFormatError(input);
			}
		});
		input.addEventListener('input', () => validateNumericScore(input));
		input.addEventListener('blur', () => validateNumericScore(input));
	});
	area.querySelectorAll('.score-input').forEach((control) =>
		control.addEventListener('input', () => {
			state.draftDirty = true;
			state.activeMethodChanged = true;
			const status = app.querySelector('#saveStatus');
			if (status) status.hidden = true;
		}),
	);
	area.querySelectorAll('.note-input').forEach((control) =>
		control.addEventListener('input', () => {
			state.draftDirty = true;
			state.pendingNotes = captureDraftNotes();
			const status = app.querySelector('#saveStatus');
			if (status) status.hidden = true;
		}),
	);
}

function validateNumericMaximum(input, focus = false) {
	const errorElement = input?.closest('.scale-entry')?.querySelector('.field-error');
	const maximum = Number(input?.value);
	if (input?.value !== '' && Number.isInteger(maximum) && maximum >= 2 && maximum <= 1000) {
		clearFieldError(input, errorElement);
		return true;
	}
	setFieldError(input, errorElement, 'Enter a whole number from 2 to 1,000.', focus);
	return false;
}

function validateNumericScore(input, focus = false) {
	const errorElement = input?.closest('.score-entry')?.querySelector('.field-error');
	if (!input || input.value === '') {
		clearFieldError(input, errorElement);
		return true;
	}
	if (!/^\d+$/.test(input.value)) {
		setFieldError(input, errorElement, 'Enter numbers only.', focus);
		return false;
	}
	const value = Number(input.value);
	if (Number.isInteger(value) && value >= 1 && value <= state.numericMax) {
		clearFieldError(input, errorElement);
		return true;
	}
	setFieldError(input, errorElement, `Use a whole number from 1 to ${state.numericMax}.`, focus);
	return false;
}

function showNumericFormatError(input) {
	const errorElement = input?.closest('.score-entry')?.querySelector('.field-error');
	setFieldError(input, errorElement, 'Enter numbers only.');
}

function refreshRankLabels(list) {
	state.draftDirty = true;
	state.activeMethodChanged = true;
	const isTop3 = list.dataset.mode === 'top3';
	const rankCount = Number(list.dataset.rankCount || 3);
	[...list.children].forEach((item, i) => {
		item.dataset.pos = String(i + 1);
		const pos = item.querySelector('.rank-pos');
		if (pos) pos.textContent = isTop3 && i >= rankCount ? 'Unranked' : `${ordinal(i + 1)} Place`;
		item.classList.toggle('ranked-choice', isTop3 && i < rankCount);
		item.classList.toggle('unranked-choice', isTop3 && i >= rankCount);
		item.classList.toggle('unranked-start', isTop3 && i === rankCount);
		const up = item.querySelector('.rank-up');
		const down = item.querySelector('.rank-down');
		if (up) up.disabled = i === 0;
		if (down) down.disabled = i === list.children.length - 1;
	});
	const st = app.querySelector('#saveStatus');
	if (st) st.hidden = true;
}

function rankWineData(item) {
	return {
		id: item.dataset.wine,
		label: item.querySelector('[data-rank-wine]')?.textContent || 'Wine',
	};
}

function moveWineToSlot(fromItem, targetItem) {
	const list = fromItem.parentElement;
	if (!list || targetItem.parentElement !== list) return;
	const slots = [...list.children];
	const fromIndex = slots.indexOf(fromItem);
	const targetIndex = slots.indexOf(targetItem);
	if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;
	const oldPositions = new Map(slots.map((item) => [item, item.getBoundingClientRect().top]));

	// Move the wine row itself. This is list insertion: every row between the old
	// and new positions shifts one place instead of having its contents replaced.
	if (fromIndex < targetIndex) targetItem.after(fromItem);
	else targetItem.before(fromItem);

	if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
	for (const item of list.children) {
		if (item === fromItem) continue;
		const distance = oldPositions.get(item) - item.getBoundingClientRect().top;
		if (!distance) continue;
		item.getAnimations?.().forEach((animation) => animation.cancel());
		item.animate?.([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], { duration: 170, easing: 'ease-out' });
	}
}

function createRankDragGhost(item) {
	const ghost = document.createElement('div');
	ghost.className = 'rank-drag-ghost';
	ghost.setAttribute('aria-hidden', 'true');
	ghost.innerHTML = `<span class="drag-handle">⠿</span><strong>${esc(rankWineData(item).label)}</strong>`;
	document.body.appendChild(ghost);
	return ghost;
}

function enablePointerDrag(list) {
	let activeWineId = null;
	let dropTarget = null;
	let ghost = null;
	const positionGhost = (event) => {
		if (!ghost) return;
		const bounds = ghost.getBoundingClientRect();
		const left = Math.min(Math.max(8, event.clientX + 14), Math.max(8, window.innerWidth - bounds.width - 8));
		const top = Math.max(8, event.clientY - bounds.height - 18);
		ghost.style.left = `${left}px`;
		ghost.style.top = `${top}px`;
	};
	list.addEventListener('pointerdown', (e) => {
		// Mouse input uses native drag-and-drop. This fallback is only for touch
		// and pen input, avoiding two drag systems responding at the same time.
		if (e.pointerType === 'mouse') return;
		const li = e.target.closest('li');
		if (!li || !e.target.closest('.drag-handle')) return;
		e.preventDefault();
		activeWineId = li.dataset.wine;
		dropTarget = null;
		ghost = createRankDragGhost(li);
		positionGhost(e);
		li.classList.add('dragging');
		e.target.setPointerCapture?.(e.pointerId);
	});
	list.addEventListener('pointermove', (e) => {
		if (!activeWineId) return;
		e.preventDefault();
		positionGhost(e);
		const el = document.elementFromPoint(e.clientX, e.clientY);
		const over = el?.closest('li');
		const activeLi = list.querySelector(`li[data-wine="${CSS.escape(activeWineId)}"]`);
		list.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
		dropTarget = null;
		if (!over || !list.contains(over) || !activeLi || over === activeLi) return;
		over.classList.add('drag-over');
		dropTarget = over;
	});
	const end = (commit) => {
		if (!activeWineId) return;
		const activeLi = list.querySelector(`li[data-wine="${CSS.escape(activeWineId)}"]`);
		if (commit && activeLi && dropTarget && activeLi !== dropTarget) {
			moveWineToSlot(activeLi, dropTarget);
		}
		list.querySelectorAll('.dragging, .drag-over').forEach((item) => item.classList.remove('dragging', 'drag-over'));
		ghost?.remove();
		ghost = null;
		activeWineId = null;
		dropTarget = null;
		refreshRankLabels(list);
	};
	list.addEventListener('pointerup', () => end(true));
	list.addEventListener('pointercancel', () => end(false));
}

function ordinal(i) {
	const s = ['th', 'st', 'nd', 'rd'];
	const v = i % 100;
	return i + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatPoints(value) {
	const number = Number(value || 0);
	return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatPlace(value) {
	const number = Number(value);
	return Number.isInteger(number) ? `${ordinal(number)} Place` : `${formatPoints(number)} average place`;
}

function moveRankWine(li, dir) {
	const list = li.parentElement;
	const items = [...list.children];
	const idx = items.indexOf(li);
	const target = idx + dir;
	if (target < 0 || target >= items.length) return;
	const wineId = li.dataset.wine;
	moveWineToSlot(li, items[target]);
	refreshRankLabels(list);
	list.querySelector(`li[data-wine="${CSS.escape(wineId)}"] .${dir < 0 ? 'rank-up' : 'rank-down'}`)?.focus();
}

async function submitCurrent(wines, mode) {
	const ratings = [];
	let firstInvalidNumeric = null;
	if (mode === 'numeric') {
		const scaleInput = app.querySelector('#ballotNumericMax');
		if (!validateNumericMaximum(scaleInput)) firstInvalidNumeric = scaleInput;
		app.querySelectorAll('.score-input').forEach((i) => {
			if (!validateNumericScore(i) && !firstInvalidNumeric) firstInvalidNumeric = i;
			if (i.value !== '') {
				const v = Number(i.value);
				if (Number.isInteger(v) && v >= 1 && v <= state.numericMax) ratings.push({ wineId: i.dataset.wine, value: v });
			}
		});
	} else if (mode === 'ranked') {
		[...app.querySelectorAll('#rankList li')].forEach((li, idx) => ratings.push({ wineId: li.dataset.wine, value: idx + 1 }));
	} else if (mode === 'top3') {
		[...app.querySelectorAll('#rankList li')].forEach((li, idx) => {
			if (idx < 3) ratings.push({ wineId: li.dataset.wine, value: idx + 1 });
		});
	}
	if (firstInvalidNumeric) {
		const errorElement = firstInvalidNumeric.closest('.score-entry, .scale-entry')?.querySelector('.field-error');
		setFieldError(firstInvalidNumeric, errorElement, errorElement?.textContent || 'Check this value.', true);
		return;
	}
	if (!ratings.length) {
		showError('Score at least one wine first.');
		return;
	}
	if (mode === 'numeric' && ratings.length !== wines.length) {
		const scored = new Set(ratings.map((rating) => rating.wineId));
		const missing = wines
			.filter((wine) => !scored.has(wine.id))
			.map((wine) => `Wine ${wine.blindCode}`)
			.join(', ');
		if (
			!confirm(
				`${missing} ${ratings.length === wines.length - 1 ? 'is' : 'are'} blank. Save ${ratings.length === wines.length - 1 ? 'it' : 'them'} as tied and unranked below every wine you scored?`,
			)
		) {
			return;
		}
	}
	const notes = [...app.querySelectorAll('.note-input')].map((input) => ({
		wineId: input.dataset.noteWine,
		note: input.value,
	}));
	state.methodDrafts[mode] = captureBallotDraft(wines, mode, state.activeMethodChanged);
	state.activeMethodChanged = false;
	state.pendingNotes = Object.fromEntries(notes.map((note) => [note.wineId, note.note]));
	const submitButtons = [...app.querySelectorAll('[data-submit-ballot]')];
	submitButtons.forEach((button) => {
		button.disabled = true;
		button.setAttribute('aria-busy', 'true');
		button.textContent = 'Submitting ballot…';
	});
	try {
		await participantApi('/api/participant/ballot', {
			room: state.room,
			mode,
			numericMax: state.numericMax,
			ratings,
			notes,
		});
		state.draftDirty = false;
		state.pendingNotes = null;
		announceStatus('Ballot submitted successfully.');
		await fetchSnapshot();
	} catch (error) {
		showError(error.message);
		const hasSubmitted = Object.keys((state.snapshot?.ratings || {})[state.participantId] || {}).length > 0;
		submitButtons.forEach((button) => {
			button.disabled = false;
			button.removeAttribute('aria-busy');
			button.textContent =
				button.dataset.submitBallot === 'notes'
					? hasSubmitted
						? 'Update ballot and notes'
						: 'Submit ballot and notes'
					: hasSubmitted
						? 'Update my ballot'
						: 'Submit my ballot';
		});
	}
}

// ==========================================================================
// RESULTS
// ==========================================================================
function renderResults(snap, me) {
	if (snap.event.presentation && !snap.event.presentation.complete) {
		return renderPresentation(snap);
	}
	const results = snap.results || [];
	const winesById = new Map((snap.wines || []).map((w) => [w.id, w]));
	const winners = results.filter((result) => result.place === 1);
	const isTie = winners.length > 1;
	const maxPlace = Math.max(0, ...results.map((result) => result.place));
	const potTotal = snap.event.pot && snap.event.contributionCount ? snap.event.pot * snap.event.contributionCount : null;

	const winnerEntries = winners
		.map((result) => {
			const wine = winesById.get(result.wineId);
			const primary = wine?.broughtBy || wine?.name || 'Winning wine';
			const details = [`Wine ${wine?.blindCode || result.blindCode}`, wine?.name, wine?.producer].filter(Boolean).join(' · ');
			return `<div class="winner-entry">
      <div class="winner-couple">${esc(primary)}</div>
      <div class="winner-wine">${esc(details)}</div>
    </div>`;
		})
		.join('');

	app.innerHTML = `
    <div class="print-header">
      <div class="print-kicker">Wine Night results</div>
      <h1>${esc(snap.event.theme || 'Wine Night')}</h1>
      <div>${results.length} wine${results.length === 1 ? '' : 's'} tasted</div>
    </div>
    <div class="banner">
      <div class="banner-kicker">${isTie ? 'Tie for 1st Place' : winners.length ? '1st Place · Winner takes the pot' : 'The pot'}</div>
      ${potTotal ? `<div class="pot-total">\$${formatPoints(potTotal)}</div>` : ''}
      ${winnerEntries}
      ${isTie && potTotal ? '<div class="winner-note">Split the pot or hold a taste-off.</div>' : ''}
    </div>

    <div class="card final-ranking-card">
      <h2>Final ranking</h2>
      ${results
				.map((r) => {
					const w = winesById.get(r.wineId);
					const last = r.place === maxPlace && maxPlace > 3;
					let tag = '';
					if (r.place === 1) tag = `<span class="rank-tag tag-gold">${isTie ? 'Co-winner' : 'Winner'}</span>`;
					else if (last) tag = '<span class="rank-tag tag-last">Last Place</span>';
					return `
        <div class="result-item ${r.place === 1 ? 'place-1' : last ? 'place-last' : ''}">
          <div class="place" aria-label="${esc(`${ordinal(r.place)} Place`)}">${esc(ordinal(r.place))}<span aria-hidden="true">Place</span></div>
          <div style="flex:1">
            <div class="result-name">${esc(w ? w.name : '?')} <span class="result-wine-number">Wine ${esc(w ? w.blindCode : '')}</span> ${tag}</div>
            <div class="result-meta">${esc([w?.producer, w?.price ? `\$${w.price}` : '', w?.broughtBy].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="result-score">${formatPoints(r.score)} pts</div>
        </div>`;
				})
				.join('')}
    </div>

    ${renderWineDetails(snap, results, winesById)}

    ${renderGroupInsights(snap)}

    ${renderPersonalInsights(snap, me)}

    ${state.isHost ? renderHostVotesTable(snap) : ''}

    <div class="card methodology-card">
      <h2>How the scores work</h2>
      <div class="glossary">
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Ranked_voting" target="_blank" rel="noopener noreferrer">Ranking <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> Every ballot is turned into an ordering of the wines, so different numeric scales and ranking styles are comparable.</p>
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Ranking_%28statistics%29" target="_blank" rel="noopener noreferrer">Normalization <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> Numeric scores are converted to an ordering per person, so someone who scores around 50 and someone who scores around 80 have equal influence. Blank numeric entries are treated like a partial ballot: tied with each other below every wine that person scored.</p>
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Borda_count" target="_blank" rel="noopener noreferrer">Borda count <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> First place gets the most points and each lower place gets fewer. On a partial ballot, all blank or unranked wines are tied across the remaining places. That keeps every person's total ballot weight equal.</p>
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Condorcet_method" target="_blank" rel="noopener noreferrer">Condorcet method <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> If one wine beats every other wine head-to-head when each pair of voters is compared, it's the clear winner.</p>
        <p><b>How decisive was it?</b> A plain-language description based on the head-to-head share, Borda margin, and ballot count. It is not a <a class="glossary-link" href="https://en.wikipedia.org/wiki/Statistical_significance" target="_blank" rel="noopener noreferrer">statistical significance test <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>.</p>
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Variance" target="_blank" rel="noopener noreferrer">Rank variance <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> The average squared distance of a wine's ranks from its mean rank, including tied midranks for unranked entries. Zero means complete agreement. Its scale depends on the number of wines, so it is best compared within the same tasting.</p>
        <p><b><a class="glossary-link" href="https://en.wikipedia.org/wiki/Spearman%27s_rank_correlation_coefficient" target="_blank" rel="noopener noreferrer">Spearman correlation <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></b> Measures how much two rankings agree (used for your palate twin and group alignment).</p>
      </div>
    </div>

    <div class="result-footer-actions no-print">
      <button class="btn secondary print-results print-footer-action" id="printResults">
        <svg class="print-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z" />
        </svg>
        <span>Print or save as PDF</span>
      </button>
      ${state.isHost ? hostArchiveButton() : ''}
    </div>
  `;
	onBtn(app, '#printResults', () => window.print());
	wireHostArchiveButton();
}

function renderPresentation(snap) {
	const presentation = snap.event.presentation;
	const winesById = new Map((snap.wines || []).map((wine) => [wine.id, wine]));
	const results = snap.results || [];
	const maxPlace = presentation.lastPlace || Math.max(0, ...results.map((result) => result.place));
	const revealedPlaces = [...(presentation.revealedPlaces || [])].reverse();
	const revealed = revealedPlaces.flatMap((place) => results.filter((result) => result.place === place));
	const next = presentation.nextPlace;
	const fullRevealNext = next === 1;
	const nextLabel = fullRevealNext ? 'Full results' : next === maxPlace ? 'Last Place' : `${ordinal(next)} Place`;
	const previewCount = Math.max(0, presentation.totalSteps - 1);
	const previewsRevealed = Math.min(presentation.step, previewCount);
	const progressText = previewCount ? `${previewsRevealed} of ${previewCount} preview reveals complete` : 'Ready for the full reveal';
	const previousStep = state.presentationStep;
	const animateNewReveal = previousStep != null && presentation.step === previousStep + 1;
	state.presentationStep = presentation.step;
	app.innerHTML = `
    <div class="banner reveal-banner">
      <div class="banner-kicker">Results are locked</div>
      <div class="big">The reveal</div>
      <div>${esc(progressText)}</div>
    </div>
    <div class="card reveal-controls" style="text-align:center">
      ${
				state.isHost
					? `<div class="hint">Everyone will see the next placement at the same time.</div>
           <button class="btn gold" id="revealNext">${fullRevealNext ? 'Reveal full results' : `Reveal ${esc(nextLabel)}`}</button>`
					: `<div class="reveal-waiting">
             <h2>Waiting for the host…</h2>
             <div class="hint">Next up: ${esc(nextLabel)}</div>
           </div>`
			}
    </div>
		<div class="reveal-list" aria-live="polite">
    ${revealed
			.map((result) => {
				const wine = winesById.get(result.wineId);
				const placeLabel = result.place === maxPlace ? 'Last Place' : `${ordinal(result.place)} Place`;
				return `<div class="card reveal-card" data-reveal-place="${result.place}">
          <div class="place">${esc(placeLabel)}</div>
          <h2>${esc(wine?.broughtBy || wine?.name || 'Unknown wine')}</h2>
          <div class="reveal-wine">Wine ${esc(wine?.blindCode || result.blindCode)} · ${esc(wine?.name || 'Unknown wine')}${wine?.producer ? ` · ${esc(wine.producer)}` : ''}</div>
        </div>`;
			})
			.join('')}
		</div>`;
	if (animateNewReveal && revealedPlaces.length) animatePresentationReveal(revealedPlaces[0]);
	if (state.isHost) {
		onBtn(app, '#revealNext', async () => {
			try {
				const button = app.querySelector('#revealNext');
				if (button) button.disabled = true;
				await api('/api/host/reveal-next', { room: state.room });
				await fetchSnapshot();
			} catch (error) {
				showError(error.message);
				const button = app.querySelector('#revealNext');
				if (button) button.disabled = false;
			}
		});
	}
}

function animatePresentationReveal(revealedPlace) {
	if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
	const cards = [...app.querySelectorAll('.reveal-card')];
	const newCards = cards.filter((card) => Number(card.dataset.revealPlace) === revealedPlace);
	const previousCards = cards.filter((card) => Number(card.dataset.revealPlace) !== revealedPlace);
	if (!newCards.length) return;

	const shiftDistance = previousCards.length ? previousCards[0].getBoundingClientRect().top - newCards[0].getBoundingClientRect().top : 0;
	for (const card of previousCards) {
		card.animate?.([{ transform: `translateY(-${shiftDistance}px)` }, { transform: 'translateY(0)' }], {
			duration: 280,
			easing: 'cubic-bezier(.2,.8,.2,1)',
		});
	}
	newCards.forEach((card, index) => {
		card.animate?.(
			[
				{ opacity: 0, transform: 'translateY(-18px) scale(.98)' },
				{ opacity: 1, transform: 'translateY(0) scale(1)' },
			],
			{ duration: 280, delay: index * 45, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
		);
	});
}

function renderConfidence(snap) {
	const confidence = snap.confidence;
	if (!confidence) return '';
	const share = Math.round(confidence.winnerShare * 100);
	const detail =
		confidence.level === 'tied'
			? 'The leading wines finished with equal Borda scores and no definitive head-to-head winner.'
			: `The winner led the runner-up on ${share}% of comparable ballots${confidence.condorcetWinner ? ' and beat every wine head-to-head' : ''}. Borda margin: ${formatPoints(confidence.bordaMargin)} point${confidence.bordaMargin === 1 ? '' : 's'}.`;
	return `<div class="insight-section confidence confidence-${esc(confidence.level)}">
    <h3>How decisive was it?</h3>
    <div class="match-box"><strong>${esc(confidence.summary)}</strong></div>
    <div class="hint">${esc(detail)}</div>
  </div>`;
}

function renderSavedNotes(snap) {
	const notes = snap.notes || {};
	const winesById = new Map((snap.wines || []).map((wine) => [wine.id, wine]));
	const entries = Object.entries(notes).filter(([, note]) => note);
	if (!entries.length) return '';
	return `<div class="insight-section">
    <h3>Your tasting notes</h3>
    ${entries
			.map(([wineId, note]) => {
				const wine = winesById.get(wineId);
				return `<div class="saved-note"><strong>Wine ${esc(wine?.blindCode || '?')} · ${esc(wine?.name || 'Wine')}</strong><p>${esc(note)}</p></div>`;
			})
			.join('')}
  </div>`;
}

function renderWineDetails(snap, results, winesById) {
	if (!results.length) return '';
	const statsById = new Map((snap.analytics?.wineStats || []).map((stat) => [stat.wineId, stat]));
	const rows = results.map((r) => {
		const w = winesById.get(r.wineId);
		const stat = statsById.get(r.wineId);
		return {
			label: w ? w.name : '?',
			ranks: stat?.ranks || [],
			average: stat?.avgRank || r.place,
			color: r.place === 1 ? '#8a641f' : undefined,
		};
	});
	return `
    <div class="card wine-details-card">
      <h2>How far apart were the wines?</h2>
      <div class="chart-sub">Each dot is one anonymous ballot placement. A numbered marker groups ballots with the same placement. The line shows the full range and the diamond marks the average. Rank 1 is best.</div>
      ${window.WNcharts?.rankDistributionChart ? window.WNcharts.rankDistributionChart(rows, { maxRank: (snap.wines || []).length }) : ''}
      ${renderConfidence(snap)}
      ${renderValue(snap, winesById)}
      ${renderMostConsistent(snap, winesById)}
      ${renderDebateWines(snap, winesById)}
    </div>`;
}

function renderMostConsistent(snap, winesById) {
	const consistent = [...(snap.analytics?.wineStats || [])]
		.filter((stat) => stat.n >= 2)
		.sort((a, b) => a.variance - b.variance || a.avgRank - b.avgRank)[0];
	if (!consistent) return '';
	const wine = winesById.get(consistent.wineId);
	return `<div class="insight-section">
    <h3>Most consistently placed</h3>
    <div class="wine-stat-item">
      <div class="wine-stat-badge">Wine ${esc(wine?.blindCode || consistent.blindCode)}</div>
      <div style="flex:1">
        <div><strong>${esc(wine?.name || `Wine ${consistent.blindCode}`)}</strong></div>
        <div class="hint"><strong>Rank variance ${Number(consistent.variance).toFixed(2)}</strong> · average placement ${esc(formatPoints(consistent.avgRank))}</div>
      </div>
    </div>
  </div>`;
}

function renderDebateWines(snap, winesById) {
	const stats = snap.analytics?.wineStats || [];
	const polar = stats.filter((s) => s.polarizing);
	const debateItems = polar
		.sort((a, b) => b.variance - a.variance)
		.map((s) => {
			const w = winesById.get(s.wineId);
			const name = w ? w.name || 'Wine ' + s.blindCode : 'Wine ' + s.blindCode;
			const range = s.minRank && s.maxRank ? `${formatPlace(s.minRank)} to ${formatPlace(s.maxRank)}` : '';
			return `<div class="wine-stat-item">
        <div class="wine-stat-badge">Wine ${esc(s.blindCode)}</div>
        <div style="flex:1">
          <div><strong>${esc(name)}</strong></div>
          <div class="hint"><strong>Rank variance ${Number(s.variance).toFixed(2)}</strong>${range ? ` · range ${esc(range)}` : ''}</div>
        </div>
      </div>`;
		})
		.join('');
	if (!debateItems) return '';
	return `<div class="insight-section">
    <h3>The debate wines</h3>
    <div class="hint">The highest-variance 20% of wines with at least two ballots and some disagreement.</div>
    ${debateItems}
  </div>`;
}

function renderGroupInsights(snap) {
	const correlation = snap.correlation;
	const mostConsensual = correlation?.mostConsensual;
	if (!mostConsensual) return '';
	const groupPct = mostConsensual ? Math.round(((mostConsensual.correlation + 1) / 2) * 100) : null;
	return `
    <div class="card group-insights-card">
      <div class="section-label">Visible to everyone</div>
      <h2>The tasters</h2>
      ${
				mostConsensual
					? `<div class="insight-section">
        <h3 class="person-stat-heading"><span class="stat-emoji" aria-hidden="true">🎯</span> Most in sync with the group</h3>
        <div class="match-box"><strong>${esc(mostConsensual.name)}</strong> ranked closest to everyone else's consensus (${groupPct}% alignment).</div>
      </div>`
					: ''
			}
    </div>`;
}

function renderPersonalInsights(snap, me) {
	if (!me) return '';
	const analytics = snap.analytics;
	if (!analytics) return '';
	const mine = analytics.participants[me.id];
	if (!mine) return '';
	const winesById = new Map((snap.wines || []).map((w) => [w.id, w]));
	// Group alignment: how closely you matched the overall consensus.
	const group = (snap.correlation?.groupMatch || {})[me.id];
	const groupPct = group != null ? Math.round(((group + 1) / 2) * 100) : null;
	const twin = snap.correlation?.matchByName?.[me.id];
	const twinPct = twin ? Math.round(((twin.correlation + 1) / 2) * 100) : null;
	const raw = mine.rawSpread;
	const scaleMax = me.numericMax || 100;
	const spreadVisual = raw
		? `<div class="spread-track">
        <div class="spread-fill" style="left:${(raw.min / scaleMax) * 100}%;width:${Math.max(2, (raw.range / scaleMax) * 100)}%"></div>
      </div>
      <div class="spread-labels"><span>1</span><span>${esc(scaleMax)}</span></div>`
		: '';
	const spreadNote = raw
		? raw.range / scaleMax >= 0.4
			? 'You used a wide scoring range and clearly separated the field.'
			: raw.range / scaleMax <= 0.15
				? 'You kept your numeric scores close together.'
				: 'You used a moderate numeric scoring range.'
		: '';

	const finalPlaces = new Map((snap.results || []).map((result) => [result.wineId, result.place]));
	const comparison = [...(mine.comparison || [])].sort(
		(a, b) => a.effectiveRank - b.effectiveRank || (finalPlaces.get(a.wineId) || 999) - (finalPlaces.get(b.wineId) || 999),
	);
	const favoriteRank = Math.min(...comparison.filter((entry) => entry.yourRank != null).map((entry) => entry.yourRank), Infinity);
	const comparisonHtml = comparison.length
		? `<div class="insight-section">
        <h3>Your ballot versus the final ranking</h3>
        <div class="ballot-comparison">
          ${comparison
						.map((entry) => {
							const wine = winesById.get(entry.wineId);
							const finalPlace = finalPlaces.get(entry.wineId) ?? entry.consensusRank;
							const isFavorite = entry.yourRank != null && entry.yourRank === favoriteRank;
							return `<div class="ballot-comparison-row ${isFavorite ? 'personal-favorite' : ''}">
              <div class="comparison-wine">
                <strong>Wine ${esc(wine?.blindCode || '?')} · ${esc(wine?.name || 'Wine')}</strong>
                ${isFavorite ? '<span class="rank-tag tag-gold">Your top choice</span>' : ''}
                <div class="hint">${esc([wine?.producer, wine?.broughtBy].filter(Boolean).join(' · '))}</div>
              </div>
              <div class="comparison-places">
                <span><small>You</small><strong>${entry.yourRank == null ? 'Unranked' : esc(formatPlace(entry.yourRank))}</strong></span>
                <span><small>The group</small><strong>${esc(formatPlace(finalPlace))}</strong></span>
              </div>
            </div>`;
						})
						.join('')}
        </div>
      </div>`
		: '';

	return `
    <div class="card personal-insights-card">
      <div class="section-label">Private to you</div>
      <h2>Your tasting profile</h2>
      ${
				twin
					? `<div class="insight-section">
        <h3 class="person-stat-heading"><span class="stat-emoji" aria-hidden="true">🥂</span> Your palate twin</h3>
        <div class="match-box"><strong>${esc(twin.matchName)}</strong> was your closest match (${twinPct}% alignment).</div>
      </div>`
					: ''
			}
      ${
				groupPct != null
					? `<div class="insight-section">
        <h3 class="person-stat-heading"><span class="stat-emoji" aria-hidden="true">👥</span> Your alignment with the group</h3>
        <div class="match-box"><strong>${groupPct}% alignment</strong> with everyone else's consensus, calculated without counting your own ballot in the comparison.</div>
      </div>`
					: ''
			}
      ${
				raw
					? `<div class="bstats"><span>Scores used</span><strong>${raw.min} to ${raw.max}</strong></div>
      <div class="bstats"><span>Numeric spread</span><strong>${raw.range} points</strong></div>`
					: ''
			}
      ${spreadVisual}
      ${spreadNote ? `<div class="hint">${spreadNote}</div>` : ''}
      ${comparisonHtml}
      ${renderSavedNotes(snap)}
    </div>`;
}

function renderHostVotesTable(snap) {
	const wines = snap.wines || [];
	const participants = snap.participants || [];
	const ratings = snap.ratings || {};
	if (!participants.length || !wines.length) return '';
	const header = wines.map((w) => `<th>Wine ${esc(w.blindCode)}</th>`).join('');
	const rows = participants
		.map((p) => {
			const mine = ratings[p.id] || {};
			const cells = wines
				.map((w) => {
					const v = mine[w.id];
					return `<td>${v != null ? esc(v) : '·'}</td>`;
				})
				.join('');
			const mode = p.mode === 'numeric' ? `score 1 to ${p.numericMax || 100}` : p.mode === 'top3' ? 'top 3' : 'full rank';
			return `<tr><th>${esc(p.name)} (${esc(mode)})</th>${cells}</tr>`;
		})
		.join('');
	return `
    <div class="card host-votes-card" style="overflow-x:auto">
      <div class="section-label">Host only</div>
      <h2>All votes</h2>
      <table class="votes-table">
        <thead><tr><th>Voter</th>${header}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="hint">Raw values as entered on each person's chosen scale, or place (1 = best). A dot means tied and unranked on a partial ballot.</div>
    </div>`;
}

function renderValue(snap, winesById) {
	// best value = quality score / price. Only meaningful when price is set.
	const scored = (snap.results || [])
		.map((r) => {
			const w = winesById.get(r.wineId);
			if (!w || !w.price || w.price <= 0) return null;
			return { ...r, name: w.name, blindCode: w.blindCode, price: w.price, valueRatio: r.score / w.price };
		})
		.filter(Boolean)
		.sort((a, b) => b.valueRatio - a.valueRatio);
	if (!scored.length) return '';
	const top = scored[0];
	return `
    <div class="insight-section">
      <h3>Best value</h3>
      <div class="wine-stat-item">
        <div class="wine-stat-badge">Wine ${esc(top.blindCode)}</div>
        <div style="flex:1">
          <div><strong>${esc(top.name || `Wine ${top.blindCode}`)}</strong></div>
          <div class="hint"><strong>${Number(top.valueRatio).toFixed(2)} consensus points per dollar</strong> · $${esc(top.price)} bottle</div>
        </div>
      </div>
    </div>`;
}

// Show a join QR code + pre-filled link for the room.
function showJoinQR(room) {
	const url = location.origin + '/' + room;
	const root = document.getElementById('modalRoot');
	root.innerHTML = `
    <div class="overlay" id="qrOverlay">
      <div class="overlay-card" role="dialog" aria-modal="true" aria-labelledby="qrTitle">
        <div class="overlay-head">
          <h2 id="qrTitle">Join this night</h2>
          <button class="overlay-close" id="qrClose" aria-label="Close">✕</button>
        </div>
        <div class="qr-box">
          <canvas id="qrCanvas" role="img" aria-label="QR code for joining room ${esc(room)}"></canvas>
          <div class="join-link">${esc(url)}</div>
          <button class="btn secondary" id="copyLink" style="width:auto;padding:8px 16px">Copy link</button>
        </div>
      </div>
    </div>`;
	if (window.WNQR) {
		window.WNQR.toCanvas(url, root.querySelector('#qrCanvas'));
	} else {
		root.querySelector('#qrCanvas').outerHTML = '<div class="hint">QR not available. Use the link below.</div>';
	}
	let modalKeys;
	const close = () => {
		root.innerHTML = '';
		if (modalKeys) document.removeEventListener('keydown', modalKeys);
		document.querySelector('#showQR')?.focus();
	};
	root.querySelector('#qrClose').addEventListener('click', close);
	root.querySelector('#qrOverlay').addEventListener('click', (e) => {
		if (e.target.id === 'qrOverlay') close();
	});
	modalKeys = function (e) {
		if (e.key === 'Escape') {
			close();
		}
		if (e.key === 'Tab') {
			const focusable = [...root.querySelectorAll('button, [href], input')];
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	};
	document.addEventListener('keydown', modalKeys);
	root.querySelector('#copyLink').addEventListener('click', () => {
		navigator.clipboard?.writeText(url).then(() => {
			const b = root.querySelector('#copyLink');
			b.textContent = 'Copied!';
			setTimeout(() => (b.textContent = 'Copy link'), 1500);
		});
	});
	root.querySelector('#qrClose').focus();
}

// ---- keyboard convenience ------------------------------------------------

// Attach shared handlers / boot
document.getElementById('homeLink').addEventListener('click', (event) => {
	if (state.draftDirty && !confirm('Leave this room? Your unsaved ballot changes and tasting notes will be lost.')) {
		event.preventDefault();
	}
});

function boot() {
	if (state.room) {
		restoreRoomIdentity();
		connect();
		fetchSnapshot();
	} else {
		renderLanding();
	}
}
boot();
