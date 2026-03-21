let chartInstances = [];

// 1. 在网页导航栏注入 STAT 按钮
function injectStatButton() {
  const menuList = document.querySelector('.main-menu-list') || document.querySelector('.menu-list-container ul');
  
  if (!menuList) return;
  if (document.getElementById('cf-stat-btn')) return;

  const statLi = document.createElement('li');
  // 关键修改：加入 style="color: red; font-weight: bold;" 
  statLi.innerHTML = `<a href="javascript:void(0);" id="cf-stat-btn" style="color: red; font-weight: bold;">STAT</a>`;
  menuList.appendChild(statLi);

  document.getElementById('cf-stat-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStatPage();
  });
}

// 2. 将统计页面嵌入到主内容区（兼容性增强版）
async function openStatPage() {
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
    <div id="cf-stat-container">
      <h2>正在获取数据，请稍候...</h2>
    </div>
  `;

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = 'none';

  try {
    // 使用 await 获取 storage，方便捕获 Context 错误
    const result = await chrome.storage.local.get(['cfHandles', 'cfDays']);
    
    const handlesStr = result.cfHandles || 'tourist';
    const days = result.cfDays || 7;
    const handles = handlesStr.split(',').map(h => h.trim()).filter(h => h.length > 0);

    const cutoffTime = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    const results = [];

    for (const handle of handles) {
      const data = await fetchUserData(handle, cutoffTime);
      if (data) results.push(data);
    }

    if (results.length > 0) {
      // 按解决数 (solvedCount) 从高到低降序排序
      results.sort((a, b) => b.solvedCount - a.solvedCount);
      renderStatContent(results, days);
    } else {
      document.getElementById('cf-stat-container').innerHTML = '<h2>未能获取有效数据，请检查用户名或重试。</h2>';
    }

  } catch (e) {
    // 捕获上下文失效错误，并提示用户刷新
    if (e.message.includes('Extension context invalidated')) {
      alert("插件已更新或重载，请按 F5 刷新当前网页后再使用 STAT 功能。");
      document.getElementById('cf-stat-container').innerHTML = '<h2>插件已更新，请刷新网页。</h2>';
    } else {
      document.getElementById('cf-stat-container').innerHTML = `<h2>获取数据出错: ${e.message}</h2>`;
    }
  }
}

// 3. 获取用户数据 (新增：获取当前 Rating)
async function fetchUserData(handle, cutoffTime) {
  try {
    const [statusRes, ratingRes] = await Promise.all([
      fetch(`https://codeforces.com/api/user.status?handle=${handle}`).then(r => r.json()),
      fetch(`https://codeforces.com/api/user.rating?handle=${handle}`).then(r => r.json())
    ]);

    if (statusRes.status !== 'OK' || ratingRes.status !== 'OK') return null;

    const submissions = statusRes.result.filter(sub => sub.creationTimeSeconds >= cutoffTime);
    let totalSubs = submissions.length;
    let problemsMap = new Map();
    let contestsSet = new Set();
    let vpsSet = new Set();

    submissions.forEach(sub => {
      const p = sub.problem;
      if (!p || !p.contestId) return;
      const pKey = `${p.contestId}${p.index}`;
      if (!problemsMap.has(pKey)) {
        problemsMap.set(pKey, { name: `${p.contestId}${p.index} - ${p.name}`, rating: p.rating || 0, solved: false });
      }
      if (sub.verdict === 'OK') problemsMap.get(pKey).solved = true;

      const pType = sub.author.participantType;
      if (pType === 'CONTESTANT' || pType === 'OUT_OF_COMPETITION') contestsSet.add(sub.author.contestId);
      else if (pType === 'VIRTUAL') vpsSet.add(sub.author.contestId);
    });

    let solvedCount = 0;
    let totalRating = 0;
    let maxRating = 0;
    let ratedSolvedCount = 0;
    let problemList = [];

    problemsMap.forEach(prob => {
      problemList.push(prob);
      if (prob.solved) {
        solvedCount++;
        if (prob.rating && prob.rating > 0) {
          totalRating += prob.rating;
          maxRating = Math.max(maxRating, prob.rating);
          ratedSolvedCount++;
        }
      }
    });

    const avgRating = ratedSolvedCount > 0 ? Math.round(totalRating / ratedSolvedCount) : 0;
    const history = ratingRes.result; 
    
    // 获取当前最新 Rating（如果有参加过比赛的话）
    const currentRating = history.length > 0 ? history[history.length - 1].newRating : 0;

    return { 
      handle, 
      totalSubs, 
      solvedCount, 
      avgRating, 
      maxRating,
      contests: contestsSet.size, 
      vps: vpsSet.size, 
      problemList,
      ratingHistory: history,
      currentRating // 将当前 Rating 传递给渲染层
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}

// 4. 在嵌入容器中渲染内容 (新增：用户名颜色格式化)
function renderStatContent(results, days) {
  const container = document.getElementById('cf-stat-container');
  
  // 辅助函数：根据 Rating 格式化用户名 HTML
  const formatHandle = (handle, rating) => {
    if (rating >= 3000) {
      // Legendary Grandmaster: 首字母黑色，其余红色
      return `<span style="color: black; font-weight: bold;">${handle[0]}</span><span style="color: red; font-weight: bold;">${handle.slice(1)}</span>`;
    }
    
    let color = '#808080'; // Newbie 或 Unrated
    if (rating >= 1200 && rating < 1400) color = '#008000';      // Pupil
    else if (rating >= 1400 && rating < 1600) color = '#03A89E'; // Specialist
    else if (rating >= 1600 && rating < 1900) color = '#0000FF'; // Expert
    else if (rating >= 1900 && rating < 2100) color = '#AA00AA'; // Candidate Master
    else if (rating >= 2100 && rating < 2400) color = '#FF8C00'; // Master / IM
    else if (rating >= 2400) color = '#FF0000';                  // Grandmaster+

    return `<span style="color: ${color}; font-weight: bold;">${handle}</span>`;
  };

  let html = `<h2>最近 ${days} 天数据统计</h2>
    <table class="cf-stat-table">
      <thead><tr>
        <th>用户</th>
        <th>解决数</th>
        <th>提交数</th>
        <th>平均 Rating</th>
        <th>最高 Rating</th>
        <th>参加 Contest 数</th>
        <th>参加 VP 数</th>
      </tr></thead>
      <tbody>`;
  
  results.forEach(res => {
    // 渲染时调用 formatHandle 为用户名上色
    const styledHandle = formatHandle(res.handle, res.currentRating);

    html += `<tr>
             <td><a href="/profile/${res.handle}" target="_blank" style="text-decoration: none;">${styledHandle}</a></td>
             <td>${res.solvedCount}</td>
             <td>${res.totalSubs}</td>
             <td>${res.avgRating || 0}</td>
             <td>${res.maxRating || 0}</td>
             <td>${res.contests}</td>
             <td>${res.vps}</td>
             </tr>`;
  });
  html += `</tbody></table>`;

  html += `
    <div class="cf-charts-container">
      <div class="cf-chart-wrapper"><canvas id="cf-chart-sub"></canvas></div>
      <div class="cf-chart-wrapper"><canvas id="cf-chart-scatter"></canvas></div>
    </div>
  `;

  html += `<div class="cf-problem-list"><h3>详细问题列表</h3>`;
  results.forEach(res => {
    // 问题列表的标题也同步上色
    html += `<h4>${formatHandle(res.handle, res.currentRating)}</h4>`;
    if (res.problemList.length === 0) {
      html += `<p>无记录</p>`;
    } else {
      html += `<ul>`;
      res.problemList.sort((a, b) => b.rating - a.rating).forEach(p => {
        const liClass = p.solved ? 'cf-solved' : 'cf-unsolved';
        const statusText = p.solved ? '<span class="status">[解决]</span>' : '<span class="status">[未解决]</span>';
        const ratingText = p.rating > 0 ? `(Rating: ${p.rating})` : `(无Rating)`;
        html += `<li class="${liClass}">${statusText} <strong>${p.name}</strong> ${ratingText}</li>`;
      });
      html += `</ul>`;
    }
  });
  html += `</div>`;

  html += `</br><h2>整体数据统计</h2>
    <div class="cf-charts-container">
      <div class="cf-chart-wrapper"><canvas id="cf-chart-rating"></canvas></div>
      <div class="cf-chart-wrapper"><canvas id="cf-chart-total-problems"></canvas></div>
    </div>
  `;

  container.innerHTML = html;
  setTimeout(() => renderCharts(results), 0);
}

// 5. 渲染图表
function renderCharts(results) {
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];

  // --- 图表 0: 尝试的总题数 (柱状图) ---
  const ctxTotal = document.getElementById('cf-chart-total-problems');
  if (ctxTotal) {
    chartInstances.push(new Chart(ctxTotal.getContext('2d'), {
      type: 'bar',
      data: {
        labels: results.map(r => r.handle),
        datasets: [
          { 
            label: '尝试的总题数 (去重后)', 
            data: results.map(r => r.problemList.length), 
            backgroundColor: '#36A2EB', // 蓝色柱子
            borderColor: '#36A2EB',
            borderWidth: 1
          }
        ]
      },
      options: { 
        responsive: true, 
        plugins: { title: { display: true, text: '尝试的总题数统计' } },
        scales: { y: { beginAtZero: true } } 
      }
    }));
  }

  // --- 图表 1: 提交与解决对比 (保持不变) ---
  const ctx1 = document.getElementById('cf-chart-sub');
  if (ctx1) {
    chartInstances.push(new Chart(ctx1.getContext('2d'), {
      type: 'line',
      data: {
        labels: results.map(r => r.handle),
        datasets: [
          { label: '总提交数', data: results.map(r => r.totalSubs), borderColor: '#e500f9ff', backgroundColor: '#e500f9ff', fill: false },
          { label: '解决题目数', data: results.map(r => r.solvedCount), borderColor: '#00A900', backgroundColor: '#00A900', fill: false }
        ]
      },
      options: { responsive: true, plugins: { title: { display: true, text: '提交与解决对比' } } }
    }));
  }

  // --- 图表 2: 全量段位变化图 (折线图) ---
  const ctx2 = document.getElementById('cf-chart-rating');
  if (ctx2) {
    // 找出所有用户中参加比赛最多的场数，用于生成 X 轴标签
    const maxContests = Math.max(...results.map(r => r.ratingHistory.length));
    const labels = Array.from({length: maxContests}, (_, i) => `第 ${i + 1} 场`);

    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A900'];

    const historyDatasets = results.map((res, index) => {
      return {
        label: res.handle,
        data: res.ratingHistory.map(h => h.newRating), // 依次提取每次比赛后的 Rating
        borderColor: colors[index % colors.length],
        backgroundColor: colors[index % colors.length],
        fill: false,
        borderWidth: 2,
        pointRadius: 1, // 历史点位较多，缩小圆点尺寸
        tension: 0.2
      };
    });

    chartInstances.push(new Chart(ctx2.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: historyDatasets
      },
      options: {
        responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          title: { display: true, text: '段位成长曲线 (按参加比赛场次排列)' },
          tooltip: {
            callbacks: {
              // 在悬停提示中显示比赛名称
              afterLabel: function(context) {
                const userIndex = context.datasetIndex;
                const contestIndex = context.dataIndex;
                const contest = results[userIndex].ratingHistory[contestIndex];
                return contest ? `比赛: ${contest.contestName}` : "";
              }
            }
          }
        },
        scales: {
          y: { 
            title: { display: true, text: 'Rating' },
            suggestedMin: 800 
          },
          x: {
            title: { display: true, text: '比赛总场次' },
            ticks: { maxTicksLimit: 20 } // 限制 X 轴标签密度
          }
        }
      }
    }));
  }

  // 图表 3: 题目 Rating 同心饼图 (按段位渐变)
  const ctx3 = document.getElementById('cf-chart-scatter');
  if (ctx3) {
    const validPieResults = results.filter(res => 
      res.problemList.some(p => p.solved && p.rating > 0)
    );

    if (validPieResults.length > 0) {
      let allRatings = new Set();
      validPieResults.forEach(res => {
        res.problemList.forEach(p => {
          if (p.solved && p.rating > 0) allRatings.add(p.rating);
        });
      });
      
      const sortedRatings = Array.from(allRatings).sort((a, b) => a - b);
      const pieLabels = sortedRatings.map(r => r + ' 分');

      // 核心修改：动态渐变颜色计算函数
      const getCfGradientColor = (rating) => {
        // 向下取整到百位，如 1450 -> 1400
        let r = Math.floor(rating / 100) * 100;
        
        let baseColor, maxR;
        let stepSize = 0.20; // 同一段位内，每低100分混入 20% 的白色

        // 根据 CF 段位划分基本颜色和该段位的“封顶分数”(maxR)
        if (r < 1200) {
            baseColor = [128, 128, 128]; // 灰色 (Newbie)
            maxR = 1100;
        } else if (r < 1400) {
            baseColor = [0, 128, 0];     // 绿色 (Pupil)
            maxR = 1300;
        } else if (r < 1600) {
            baseColor = [3, 168, 158];   // 青色 (Specialist)
            maxR = 1500;
        } else if (r < 1900) {
            baseColor = [0, 0, 255];     // 蓝色 (Expert)
            maxR = 1800;
        } else if (r < 2100) {
            baseColor = [170, 0, 170];   // 紫色 (Candidate Master)
            maxR = 2000;
        } else if (r < 2400) {
            baseColor = [255, 140, 0];   // 橙色 (Master/IM)
            maxR = 2300;
        } else {
            baseColor = [255, 0, 0];     // 红色 (Grandmaster+)
            maxR = 3000;                 // 设定3000为纯红
            stepSize = 0.08;             // 红色跨度大，渐变幅度小一点
            if (r > maxR) r = maxR;
        }

        // 计算当前分数距离该段位最高分差了多少个 100 分
        let diffSteps = Math.max(0, (maxR - r) / 100);
        
        // 限制最多变浅 80%，防止变成纯白色看不见
        let lightenFactor = Math.min(0.8, diffSteps * stepSize); 

        // RGB 混色算法：原色 + (白色 - 原色) * 浅化比例
        let R = Math.round(baseColor[0] + (255 - baseColor[0]) * lightenFactor);
        let G = Math.round(baseColor[1] + (255 - baseColor[1]) * lightenFactor);
        let B = Math.round(baseColor[2] + (255 - baseColor[2]) * lightenFactor);

        return `rgb(${R}, ${G}, ${B})`;
      };

      // 为每一个出现的分数生成其专属的渐变色
      const bgColors = sortedRatings.map(r => getCfGradientColor(r));

      const pieDatasets = validPieResults.map((res) => {
        const counts = {};
        res.problemList.forEach(p => {
          if (p.solved && p.rating > 0) {
            counts[p.rating] = (counts[p.rating] || 0) + 1;
          }
        });
        
        const data = sortedRatings.map(r => counts[r] || 0);

        return {
          label: res.handle,
          data: data,
          backgroundColor: bgColors,
          borderWidth: 1,
          borderColor: '#ffffff'
        };
      });

      chartInstances.push(new Chart(ctx3.getContext('2d'), {
        type: 'pie', 
        data: {
          labels: pieLabels,
          datasets: pieDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, 
          plugins: { 
            title: { 
              display: true, 
              text: '各用户解决题目 Rating 分布 (每100分递进，最深色为该段位标准色)' 
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  return `${context.dataset.label} - ${context.label}: 解决了 ${context.raw} 题`;
                }
              }
            }
          }
        }
      }));
    } else {
      ctx3.parentElement.style.display = 'none';
    }
  }
}

injectStatButton();