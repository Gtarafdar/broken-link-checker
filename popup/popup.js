import { MSG } from '../lib/messages.js';
import { getAllScans } from '../lib/storage.js';
import { timeAgo } from '../lib/utils.js';

const $ = (sel) => document.querySelector(sel);

async function loadLastScan() {
  const scans = await getAllScans();
  if (!scans.length) return;

  const last = scans[0];
  $('#lastScan').classList.remove('hidden');
  $('#lastDomain').textContent = last.domain;
  const broken = last.stats?.broken || 0;
  $('#lastStats').textContent = broken ? `${broken} broken` : 'All OK';
  $('#lastStats').style.color = broken ? 'var(--danger)' : 'var(--success)';
  $('#lastTime').textContent = timeAgo(last.startedAt);
}

async function startScan(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('http')) {
    alert('Navigate to a website first.');
    return;
  }

  await chrome.sidePanel.open({ tabId: tab.id });
  chrome.runtime.sendMessage({ type: MSG.START_SCAN, mode });
  window.close();
}

$('#scanPage').addEventListener('click', () => startScan('page'));
$('#scanDomain').addEventListener('click', () => startScan('domain'));

$('#openSidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  }
});

$('#openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('#clearMarkers').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.CLEAR_MARKERS });
});

loadLastScan();
