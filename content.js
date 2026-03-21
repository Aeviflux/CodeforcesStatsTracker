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

    // 获取当天的本地时间凌晨 00:00:00
    const targetDate = new Date();
    targetDate.setHours(0, 0, 0, 0);
    // 往前推算，包含今天在内一共 days 天的 0 点作为起点
    targetDate.setDate(targetDate.getDate() - days + 1);
    
    // 生成标准的 10 位时间戳传给后续的数据过滤
    const cutoffTime = Math.floor(targetDate.getTime() / 1000);

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

// 3. 获取用户数据 (根据官方实际 HTML 结构精准解析)
async function fetchUserData(handle, cutoffTime) {
  try {
    const [statusRes, ratingRes, profileHtml] = await Promise.all([
      fetch(`https://codeforces.com/api/user.status?handle=${handle}`).then(r => r.json()),
      fetch(`https://codeforces.com/api/user.rating?handle=${handle}`).then(r => r.json()),
      fetch(`https://codeforces.com/profile/${handle}`).then(r => r.text())
    ]);

    if (statusRes.status !== 'OK' || ratingRes.status !== 'OK') return null;

    // --- 针对提供的 HTML 结构解析历史总题数 ---
    let historicalSolvedCount = 0;
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileHtml, 'text/html');
    
    // 找到所有带有特定类名的描述节点
    const descriptions = Array.from(doc.querySelectorAll('._UserActivityFrame_counterDescription'));
    
    // 找出包含 "solved for all time" 的那个节点
    const targetDesc = descriptions.find(el => el.textContent.includes('solved for all time'));
    
    if (targetDesc && targetDesc.previousElementSibling) {
      // 获取它前面的兄弟节点的内容（即包含 "123 problems" 的 div）
      const valueText = targetDesc.previousElementSibling.textContent;
      // 使用正则 \D 剔除非数字字符，只保留数字并转换为整数
      historicalSolvedCount = parseInt(valueText.replace(/\D/g, ''), 10) || 0;
    } else {
      // 兜底正则方案，防止因 DOM 结构微调导致解析失败
      const match = profileHtml.match(/>\s*(\d+)\s*problems\s*<\/div>\s*<div[^>]*>[\s\S]*?solved for all time/i);
      if (match && match[1]) {
        historicalSolvedCount = parseInt(match[1], 10);
      }
    }

    // --- 统计全历史记录中各 Rating 的过题数 ---
    let historicalSolvedSet = new Set();
    let historicalRatingsCount = {}; // 用于存储各 Rating 的数量分布

    statusRes.result.forEach(sub => {
      if (sub.verdict === 'OK' && sub.problem && sub.problem.name) {
        if (!historicalSolvedSet.has(sub.problem.name)) {
          historicalSolvedSet.add(sub.problem.name);
          // 如果这道题有 Rating，则累加到对应的 Rating 统计中
          if (sub.problem.rating && sub.problem.rating > 0) {
            historicalRatingsCount[sub.problem.rating] = (historicalRatingsCount[sub.problem.rating] || 0) + 1;
          }
        }
      }
    });

    const submissions = statusRes.result.filter(sub => sub.creationTimeSeconds >= cutoffTime);
    let totalSubs = submissions.length;
    let problemsMap = new Map();
    let contestsSet = new Set();
    let vpsSet = new Set();

    // 关键修改：按时间从早到晚排序提交记录，方便获取“首次 AC”的时间
    submissions.sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds);

    submissions.forEach(sub => {
      const p = sub.problem;
      if (!p || !p.name) return;
      
      const pKey = p.name;
      if (!problemsMap.has(pKey)) {
        const displayPrefix = p.contestId ? `${p.contestId}${p.index} - ` : '';
        problemsMap.set(pKey, { 
          name: `${displayPrefix}${p.name}`, 
          rating: p.rating || 0, 
          solved: false,
          attempts: 0, // 尝试次数
          acTime: null // AC时间戳
        });
      }
      
      let probData = problemsMap.get(pKey);
      
      // 只有在未 AC 之前，才增加尝试次数（如果 AC 了以后再交，一般不计入为了 AC 的尝试次数）
      // 如果你想统计所有提交次数，可以去掉 !probData.solved 的判断
      if (!probData.solved) {
          probData.attempts++;
      }

      if (sub.verdict === 'OK' && !probData.solved) {
        probData.solved = true;
        probData.acTime = sub.creationTimeSeconds; // 记录首次 AC 的时间
      }

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
    const currentRating = history.length > 0 ? history[history.length - 1].newRating : 0;

    return { 
      handle, 
      totalSubs, 
      solvedCount,
      historicalSolvedCount, 
      historicalRatingsCount,
      avgRating, 
      maxRating,
      contests: contestsSet.size, 
      vps: vpsSet.size, 
      problemList,
      ratingHistory: history,
      currentRating
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}

// 4. 在嵌入容器中渲染内容
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

  let html = `<h2>最近 ${days} 天的数据统计</h2>
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
      <div class="cf-chart-wrapper"><canvas id="cf-chart-solved"></canvas></div>
      <div class="cf-chart-wrapper"><canvas id="cf-chart-solved-bubble"></canvas></div>
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

        // 格式化尝试次数与 AC 时间
        const attemptsText = `<span style="color: #666; margin-left: 10px;">(尝试: ${p.attempts} 次)</span>`;
        let timeText = '';
        if (p.solved && p.acTime) {
            const dateObj = new Date(p.acTime * 1000);
            // 格式化为 YYYY-MM-DD HH:mm
            const year = dateObj.getFullYear();
            const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            const day = dateObj.getDate().toString().padStart(2, '0');
            const hours = dateObj.getHours().toString().padStart(2, '0');
            const minutes = dateObj.getMinutes().toString().padStart(2, '0');
            
            const timeStr = `${year}-${month}-${day} ${hours}:${minutes}`;
            timeText = `<span style="color: #00A900; margin-left: 10px;">[AC于: ${timeStr}]</span>`;
        }

        html += `<li class="${liClass}">${statusText} <strong>${p.name}</strong> ${ratingText} ${attemptsText} ${timeText}</li>`;
      });
      html += `</ul>`;
    }
  });
  html += `</div>`;

  html += `</br><h2>从注册到目前为止的数据统计</h2>
    <div class="cf-charts-container">
      <div class="cf-chart-wrapper"><canvas id="cf-chart-rating"></canvas></div>
      <div class="cf-chart-wrapper"><canvas id="cf-chart-historical-solved"></canvas></div>
      <div class="cf-chart-wrapper"><canvas id="cf-chart-radar"></canvas></div>
    </div>
  `;

  container.innerHTML = html;
  setTimeout(() => renderCharts(results), 0);
}

// 5. 渲染图表
function renderCharts(results) {
  chartInstances.forEach(c => c.destroy());
  chartInstances = [];

  // 图表: 近期解决题目明细 (气泡图) 
  const ctxSolvedBubble = document.getElementById('cf-chart-solved-bubble');
  if (ctxSolvedBubble) {
    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A900'];
    
    // 关键修改 1：增加一个变量用于记录全场最高的尝试次数
    let maxAttempts = 0; 

    const bubbleDatasets = results.map((res, index) => {
      const dataPoints = [];
      res.problemList.forEach(p => {
        if (p.solved && p.acTime) {
          const isUnrated = !p.rating || p.rating === 0;
          const ratingVal = isUnrated ? 1000 : p.rating;
          
          // 更新最高尝试次数
          if (p.attempts > maxAttempts) maxAttempts = p.attempts;

          dataPoints.push({
            x: p.acTime * 1000, 
            y: p.attempts,      
            r: Math.max(4, ratingVal / 80), 
            rawRating: isUnrated ? '无 (按1000算)' : p.rating,
            name: p.name,
            isUnrated: isUnrated
          });
        }
      });

      const color = colors[index % colors.length];

      return {
        label: res.handle,
        data: dataPoints,
        backgroundColor: dataPoints.map(d => d.isUnrated ? 'transparent' : color + '80'),
        borderColor: color,
        borderWidth: 2,
        hoverBackgroundColor: color
      };
    });

    chartInstances.push(new Chart(ctxSolvedBubble.getContext('2d'), {
      type: 'bubble',
      data: { datasets: bubbleDatasets },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: '近期解决题目明细 (X轴: AC时间, Y轴: 尝试次数, 气泡大小: Rating, 空心环: 无Rating)' },
          tooltip: {
            callbacks: {
              label: function(context) {
                const point = context.raw;
                const dateObj = new Date(point.x);
                const timeStr = `${dateObj.getFullYear()}-${(dateObj.getMonth() + 1).toString().padStart(2, '0')}-${dateObj.getDate().toString().padStart(2, '0')} ${dateObj.getHours().toString().padStart(2, '0')}:${dateObj.getMinutes().toString().padStart(2, '0')}`;
                return `${context.dataset.label} | ${point.name} | Rating: ${point.rawRating} | 尝试: ${point.y}次 | AC于: ${timeStr}`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'AC 时间 (每小时间隔)' },
            ticks: {
              // 关键修改 2：强制 X 轴网格线的间隔为 1 小时 (3600秒 * 1000毫秒)
              stepSize: 3600 * 1000, 
              callback: function(value) {
                const dateObj = new Date(value);
                return `${(dateObj.getMonth() + 1).toString().padStart(2, '0')}-${dateObj.getDate().toString().padStart(2, '0')} ${dateObj.getHours().toString().padStart(2, '0')}:${dateObj.getMinutes().toString().padStart(2, '0')}`;
              }
            }
          },
          y: {
            title: { display: true, text: '尝试次数 (含AC当次)' },
            beginAtZero: true,
            // 关键修改 3：将 Y 轴的最高点设置为 最大尝试次数 + 1，留出上方空间
            suggestedMax: maxAttempts + 1, 
            ticks: { stepSize: 1 }
          }
        }
      }
    }));
  }

  // 图表: 历史总过题数
  const ctxHist = document.getElementById('cf-chart-historical-solved');
  if (ctxHist) {
    // 预设不同的颜色数组
    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A900'];
    const bgColors = results.map((_, i) => colors[i % colors.length]);

    chartInstances.push(new Chart(ctxHist.getContext('2d'), {
      type: 'bar',
      data: {
        labels: results.map(r => r.handle), // X轴为各个用户名
        datasets: [{
          label: '历史总过题数',
          data: results.map(r => r.historicalSolvedCount),
          backgroundColor: bgColors,
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { 
          title: { display: true, text: '历史总过题数统计 (注册至今)' },
          legend: { display: false } // 因为每个柱子都代表不同的用户，隐藏顶部图例更美观
        },
        scales: { y: { beginAtZero: true } }
      }
    }));
  }

  // 图表: 提交与解决对比
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

  // 图表: 全量段位变化图 (折线图)
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

  // 图表: 各用户解决题目 Rating 分布 (堆叠柱状图)
  const ctx3 = document.getElementById('cf-chart-solved');
  if (ctx3) {
    // 关键修改 1：强制调高图表容器的高度，让柱子更高更直观
    ctx3.parentElement.style.height = '450px'; 

    // 关键修改 2：去除 rating > 0 的过滤，把无 Rating (记为0) 的也包含进来
    const validPieResults = results.filter(res => 
      res.problemList.some(p => p.solved) 
    );

    if (validPieResults.length > 0) {
      // 1. 收集所有出现过的 Rating 分数
      let allRatings = new Set();
      validPieResults.forEach(res => {
        res.problemList.forEach(p => {
          if (p.solved) allRatings.add(p.rating || 0); // 无 Rating 记为 0
        });
      });
      
      // 排序，0 会自然排在第一位（即 800 的前面）
      const sortedRatings = Array.from(allRatings).sort((a, b) => a - b);
      
      // 映射 X 轴标签，把 0 转换为 "无Rating"
      const barLabels = sortedRatings.map(r => r === 0 ? '无Rating' : r + ' 分');

      // 预设高区分度的用户颜色
      const userColors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A900', '#FFB6C1'];

      // 2. 为每个用户构建数据集
      const barDatasets = validPieResults.map((res, index) => {
        const counts = {};
        res.problemList.forEach(p => {
          if (p.solved) {
            const rVal = p.rating || 0; // 同样将无 Rating 记为 0
            counts[rVal] = (counts[rVal] || 0) + 1;
          }
        });
        
        // 按照 X 轴的 Rating 顺序填入该用户的做题数量，没有则补 0
        const data = sortedRatings.map(r => counts[r] || 0);

        return {
          label: res.handle,
          data: data,
          backgroundColor: userColors[index % userColors.length],
          borderWidth: 1
        };
      });

      chartInstances.push(new Chart(ctx3.getContext('2d'), {
        type: 'bar', 
        data: {
          labels: barLabels,
          datasets: barDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, // 允许图表拉伸，配合前面的 450px 高度
          plugins: { 
            title: { 
              display: true, 
              text: '近期解决题目 Rating 分布统计' 
            },
            tooltip: {
              mode: 'index', // 鼠标悬浮时展示该分数段的所有用户做题量
              intersect: false,
              callbacks: {
                label: function(context) {
                  // 过滤掉数量为 0 的记录，让悬浮框更清爽
                  if (context.raw === 0) return null;
                  return `${context.dataset.label}: 解决了 ${context.raw} 题`;
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              title: { display: true, text: '题目 Rating' }
            },
            y: {
              stacked: true,
              title: { display: true, text: '解决数量' },
              ticks: { stepSize: 1 }
            }
          }
        }
      }));
    } else {
      ctx3.parentElement.style.display = 'none';
    }
  }

  // 图表: 历史总完成题目的 Rating 分布 (雷达图)
  const ctxRadar = document.getElementById('cf-chart-radar');
  if (ctxRadar) {
    // 1. 收集所有用户做过的所有唯一 Rating，作为雷达图的顶点标签
    let allRatings = new Set();
    results.forEach(res => {
      Object.keys(res.historicalRatingsCount).forEach(rating => {
        allRatings.add(parseInt(rating));
      });
    });

    // 2. 将 Rating 从小到大排序
    const sortedRatings = Array.from(allRatings).sort((a, b) => a - b);
    const radarLabels = sortedRatings.map(r => r + '分');

    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A900'];

    // 3. 构建每个用户的数据集
    const radarDatasets = results.map((res, index) => {
      // 匹配对应的题数，如果在某个 Rating 没有做过题，则补 0
      const dataPoints = sortedRatings.map(rating => {
        return res.historicalRatingsCount[rating] || 0;
      });

      // 雷达图需要较高的透明度，防止多边形互相遮挡导致内部数据不可见 (追加 '33' 表示 20% 透明度)
      const bgColor = colors[index % colors.length] + '33'; 
      const borderColor = colors[index % colors.length];

      return {
        label: res.handle,
        data: dataPoints,
        backgroundColor: bgColor,
        borderColor: borderColor,
        pointBackgroundColor: borderColor,
        pointBorderColor: '#fff',
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: borderColor,
        borderWidth: 2
      };
    });

    chartInstances.push(new Chart(ctxRadar.getContext('2d'), {
      type: 'radar',
      data: {
        labels: radarLabels,
        datasets: radarDatasets
      },
      options: {
        responsive: true,
        plugins: { 
          title: { display: true, text: '全量历史完成题目 Rating 分布 (多边形面积代表广度与数量)' },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `${context.dataset.label}: 解决了 ${context.raw} 题`;
              }
            }
          }
        },
        scales: {
          r: {
            angleLines: { display: true },
            suggestedMin: 0 // 确保雷达图中心点从 0 开始
          }
        }
      }
    }));
  }
}

injectStatButton();