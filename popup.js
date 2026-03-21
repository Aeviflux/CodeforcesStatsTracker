document.addEventListener('DOMContentLoaded', () => {
  // 加载上次保存的数据
  chrome.storage.local.get(['cfHandles', 'cfDays'], (result) => {
    document.getElementById('handles').value = result.cfHandles || 'tourist';
    document.getElementById('days').value = result.cfDays || 7;
  });
});

document.getElementById('saveBtn').addEventListener('click', () => {
  const handles = document.getElementById('handles').value;
  const days = parseInt(document.getElementById('days').value, 10);

  if (!handles || isNaN(days) || days <= 0) {
    alert("请输入有效的用户名和天数。");
    return;
  }

  // 保存数据
  chrome.storage.local.set({ cfHandles: handles, cfDays: days }, () => {
    const status = document.getElementById('status');
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
  });
});