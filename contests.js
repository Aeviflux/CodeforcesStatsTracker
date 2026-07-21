// 1. 在导航栏 STAT 右侧注入 CONTESTS 按钮
function injectContestsButton() {
  const menuList = document.querySelector('.main-menu-list') || document.querySelector('.menu-list-container ul');
  if (!menuList) return;
  if (document.getElementById('cf-contests-btn')) return;

  // 找到 STAT 按钮所在位置，在其后插入 CONTESTS 按钮
  const statBtn = document.getElementById('cf-stat-btn');
  const statLi = statBtn ? statBtn.closest('li') : null;

  const contestsLi = document.createElement('li');
  contestsLi.innerHTML = `<a href="javascript:void(0);" id="cf-contests-btn" style="color: red; font-weight: bold;">CONTESTS</a>`;

  if (statLi && statLi.nextSibling) {
    menuList.insertBefore(contestsLi, statLi.nextSibling);
  } else {
    menuList.appendChild(contestsLi);
  }

  document.getElementById('cf-contests-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContestsPage();
  });
}

// 2. 时间戳格式化辅助函数
function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// 3. 根据 Rating 格式化用户名颜色
function formatHandle(handle, rating) {
  if (rating >= 3000) {
    return `<span style="color: black; font-weight: bold;">${handle[0]}</span><span style="color: red; font-weight: bold;">${handle.slice(1)}</span>`;
  }

  let color = '#808080'; // Newbie / Unrated
  if (rating >= 1200 && rating < 1400) color = '#008000';
  else if (rating >= 1400 && rating < 1600) color = '#03A89E';
  else if (rating >= 1600 && rating < 1900) color = '#0000FF';
  else if (rating >= 1900 && rating < 2100) color = '#AA00AA';
  else if (rating >= 2100 && rating < 2400) color = '#FF8C00';
  else if (rating >= 2400) color = '#FF0000';

  return `<span style="color: ${color}; font-weight: bold;">${handle}</span>`;
}

// 4. 获取参与类型的中文标签
function getParticipantLabel(participantType) {
  switch (participantType) {
    case 'CONTESTANT': return 'CONTESTANT';
    case 'OUT_OF_COMPETITION': return 'OUT OF COMP';
    case 'VIRTUAL': return 'VIRTUAL';
    default: return participantType;
  }
}

// 5. 获取选手全部比赛数据（注册至今）
async function fetchUserContestData(handle, contestMap) {
  try {
    const [statusRes, ratingRes] = await Promise.all([
      fetch(`https://codeforces.com/api/user.status?handle=${handle}`).then(r => r.json()),
      fetch(`https://codeforces.com/api/user.rating?handle=${handle}`).then(r => r.json())
    ]);

    if (statusRes.status !== 'OK') return null;

    const submissions = statusRes.result;
    const ratingHistory = ratingRes.status === 'OK' ? ratingRes.result : [];
    const currentRating = ratingHistory.length > 0 ? ratingHistory[ratingHistory.length - 1].newRating : 0;

    // 按时间从早到晚排序
    submissions.sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds);

    // 按 contestId 分组，只保留比赛类型的提交
    const contestGroups = {}; // { contestId: { participantType, firstSubTime, problems: {} } }

    submissions.forEach(sub => {
      const p = sub.problem;
      if (!p || !p.name) return;

      const pType = sub.author.participantType;
      // 只收集正式参赛、非正式参赛和虚拟参赛的提交
      if (pType !== 'CONTESTANT' && pType !== 'OUT_OF_COMPETITION' && pType !== 'VIRTUAL') return;

      const cid = sub.author.contestId || p.contestId;
      if (!cid) return;

      if (!contestGroups[cid]) {
        contestGroups[cid] = {
          contestId: cid,
          participantType: pType,
          firstSubTime: sub.creationTimeSeconds,
          problems: {}
        };
      }

      // 更新最早提交时间
      if (sub.creationTimeSeconds < contestGroups[cid].firstSubTime) {
        contestGroups[cid].firstSubTime = sub.creationTimeSeconds;
      }

      const pIndex = p.index;
      if (!contestGroups[cid].problems[pIndex]) {
        contestGroups[cid].problems[pIndex] = {
          index: pIndex,
          name: p.name,
          rating: p.rating || 0,
          solved: false,
          attempts: 0,
          acTime: null,
          lastSubTime: null,
          tags: p.tags || []
        };
      }

      const probData = contestGroups[cid].problems[pIndex];

      // 未 AC 之前增加尝试次数
      if (!probData.solved) {
        probData.attempts++;
      }

      probData.lastSubTime = sub.creationTimeSeconds;

      if (sub.verdict === 'OK' && !probData.solved) {
        probData.solved = true;
        probData.acTime = sub.creationTimeSeconds;
      }
    });

    // 转换为数组并排序，同时为每个比赛获取名字
    const contestRecords = Object.values(contestGroups)
      .map(cg => ({
        ...cg,
        contestName: contestMap[cg.contestId] || `Contest #${cg.contestId}`,
        problems: Object.values(cg.problems).sort((a, b) => {
          // 按题号排序: A, B, C, ...
          return a.index.localeCompare(b.index);
        })
      }))
      .sort((a, b) => b.firstSubTime - a.firstSubTime); // 最近的比赛在前

    return {
      handle,
      currentRating,
      contestRecords
    };
  } catch (e) {
    console.error(`Error fetching data for ${handle}:`, e);
    return null;
  }
}

// 6. 渲染比赛记录页面
function renderContestsPage(results) {
  const container = document.getElementById('cf-contests-container');

  if (!results || results.length === 0) {
    container.innerHTML = '<h2>未能获取有效数据，请检查用户名或重试。</h2>';
    return;
  }

  let html = `
    <h2 style="border: none; padding: 0; margin: 0 0 15px 0;">从注册至今的全部比赛记录</h2>
  `;

  // 给每个用户分配序号，用于折叠控制
  let userIndex = 0;

  results.forEach(res => {
    const uid = `cf-contests-user-${userIndex}`;
    userIndex++;
    const styledHandle = formatHandle(res.handle, res.currentRating);
    html += `<h3 class="cf-contests-user-header" data-target="${uid}" style="cursor: pointer;">
      <span class="cf-toggle-arrow" id="${uid}-arrow">▼</span> ${styledHandle}
      <span style="font-size: 13px; color: #666; margin-left: 10px; font-weight: normal;">(${res.contestRecords.length} 场比赛)</span>
    </h3>`;

    html += `<div class="cf-contests-user-body" id="${uid}">`;

    if (res.contestRecords.length === 0) {
      html += `<p class="cf-no-contests">无比赛记录</p>`;
      html += `</div>`;
      return;
    }

    res.contestRecords.forEach(contest => {
      const typeClass = contest.participantType === 'VIRTUAL' ? 'virtual' : 'contestant';
      const icon = contest.participantType === 'VIRTUAL' ? '🎮' : '🏆';
      const typeLabel = getParticipantLabel(contest.participantType);

      const solvedProblems = contest.problems.filter(p => p.solved);
      const unsolvedProblems = contest.problems.filter(p => !p.solved);

      html += `
        <div class="cf-contest-card">
          <div class="cf-contest-header">
            <span class="contest-name">${icon} ${contest.contestName}
              <span class="cf-contest-type ${typeClass}">${typeLabel}</span>
            </span>
            <span class="contest-meta">${formatTs(contest.firstSubTime)}</span>
          </div>
          <ul class="cf-contest-problems">
      `;

      // 先显示已解决的题目
      solvedProblems.forEach(p => {
        html += buildProblemItemHtml(p);
      });

      // 再显示未解决的题目
      unsolvedProblems.forEach(p => {
        html += buildProblemItemHtml(p);
      });

      if (contest.problems.length === 0) {
        html += `<li><em style="color: #888;">无提交记录</em></li>`;
      }

      html += `
          </ul>
        </div>
      `;
    });

    html += `</div>`; // 关闭 cf-contests-user-body
  });

  container.innerHTML = html;

  // 绑定折叠/展开事件
  container.querySelectorAll('.cf-contests-user-header').forEach(header => {
    header.addEventListener('click', () => {
      const targetId = header.dataset.target;
      const body = document.getElementById(targetId);
      const arrow = document.getElementById(targetId + '-arrow');
      if (body && arrow) {
        if (body.style.display === 'none') {
          body.style.display = 'block';
          arrow.textContent = '▼';
        } else {
          body.style.display = 'none';
          arrow.textContent = '▶';
        }
      }
    });
  });
}

// 7. 构建单个题目项的 HTML
function buildProblemItemHtml(p) {
  const liClass = p.solved ? 'cf-solved' : 'cf-unsolved';
  const statusText = p.solved
    ? '<span class="cf-status">[解决]</span>'
    : '<span class="cf-status">[未解决]</span>';
  const ratingText = p.rating > 0 ? `(Rating: ${p.rating})` : `(无Rating)`;

  const attemptsText = `<span style="color: #666; margin-left: 8px;">(尝试: ${p.attempts} 次)</span>`;

  let timeText = '';
  if (p.solved && p.acTime) {
    timeText = `<span style="color: #00A900; margin-left: 8px;">[AC于: ${formatTs(p.acTime)}]</span>`;
  } else if (!p.solved && p.lastSubTime) {
    timeText = `<span style="color: red; margin-left: 8px;">[最后提交: ${formatTs(p.lastSubTime)}]</span>`;
  }

  // 算法标签
  let tagsHtml = '';
  if (p.tags && p.tags.length > 0) {
    const tagsSpans = p.tags.map(tag =>
      `<span class="cf-tag">${tag}</span>`
    ).join('');
    tagsHtml = `<div class="cf-tags-row">${tagsSpans}</div>`;
  }

  return `
    <li class="${liClass}">
      <div>${statusText} <strong>${p.index} - ${p.name}</strong> ${ratingText} ${attemptsText} ${timeText}</div>
      ${tagsHtml}
    </li>
  `;
}

// 8. 打开 CONTESTS 页面
async function openContestsPage() {
  // 找到内容区域
  let pageContent = document.getElementById('pageContent') ||
                    document.querySelector('.content-with-sidebar') ||
                    document.querySelector('#content');

  if (!pageContent) {
    pageContent = document.createElement('div');
    pageContent.id = 'cf-custom-page-content';
    pageContent.style.padding = '1em';

    const menuContainer = document.querySelector('.menu-box') || document.querySelector('#header');
    if (menuContainer) {
      menuContainer.parentNode.insertBefore(pageContent, menuContainer.nextSibling);
    } else {
      document.body.appendChild(pageContent);
    }
  }

  pageContent.innerHTML = `
    <div id="cf-contests-container">
      <h2>正在获取数据，请稍候...</h2>
    </div>
  `;

  // 隐藏侧边栏
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = 'none';

  try {
    const result = await chrome.storage.local.get(['cfHandles']);
    const handlesStr = result.cfHandles || 'tourist';
    const handles = handlesStr.split(',').map(h => h.trim()).filter(h => h.length > 0);

    // 拉取全部比赛列表，建立 contestId -> contestName 的映射
    const contestMap = {};
    try {
      const contestListRes = await fetch('https://codeforces.com/api/contest.list').then(r => r.json());
      if (contestListRes.status === 'OK') {
        contestListRes.result.forEach(c => {
          contestMap[c.id] = c.name;
        });
      }
    } catch (err) {
      console.warn('Failed to fetch contest list:', err);
    }

    const results = [];
    for (const handle of handles) {
      const data = await fetchUserContestData(handle, contestMap);
      if (data) results.push(data);
    }

    // 按总比赛场数降序排列
    results.sort((a, b) => b.contestRecords.length - a.contestRecords.length);

    if (results.length > 0) {
      renderContestsPage(results);
    } else {
      document.getElementById('cf-contests-container').innerHTML = '<h2>未能获取有效数据，请检查用户名或重试。</h2>';
    }
  } catch (e) {
    if (e.message.includes('Extension context invalidated')) {
      alert('插件已更新或重载，请按 F5 刷新当前网页后再使用 CONTESTS 功能。');
      document.getElementById('cf-contests-container').innerHTML = '<h2>插件已更新，请刷新网页。</h2>';
    } else {
      document.getElementById('cf-contests-container').innerHTML = `<h2>获取数据出错: ${e.message}</h2>`;
    }
  }
}

// 9. 初始化：注入 CONTESTS 按钮
// STAT 按钮由 content.js 注入，CONTESTS 按钮需要等它就位
function init() {
  // content.js 的 injectStatButton 在脚本末尾同步调用
  // 由于 manifest 中 contests.js 在 content.js 之后加载，
  // STAT 按钮此时应该已存在于 DOM 中
  const statBtn = document.getElementById('cf-stat-btn');
  if (statBtn) {
    injectContestsButton();
  } else {
    // 如果 STAT 按钮还没渲染（比如页面还在加载中），稍等一下再试
    const observer = new MutationObserver(() => {
      if (document.getElementById('cf-stat-btn')) {
        injectContestsButton();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 3 秒后强制停止观察，避免无限等待
    setTimeout(() => observer.disconnect(), 3000);
  }
}

init();
