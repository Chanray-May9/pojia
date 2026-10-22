/* 破甲论坛 · 渐进增强脚本
 * 静态站点的读内容不依赖本脚本；登录、发帖、回复、搜索通过 Cloudflare API 完成。
 */
(function () {
  'use strict';

  var cfg = window.POJIA_CONFIG || {};
  var API_BASE = String(cfg.apiBase || '').replace(/\/+$/, '');
  var SITE_BASE = String(cfg.base || '/');
  if (SITE_BASE.charAt(0) !== '/') SITE_BASE = '/' + SITE_BASE;
  if (SITE_BASE.slice(-1) !== '/') SITE_BASE += '/';
  var TOKEN_KEY = 'pojia_token';
  var user = null;

  function apiUrl(p) {
    return (API_BASE || '') + '/api/v1/' + String(p).replace(/^\/+/, '');
  }

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function request(path, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth && token()) headers.Authorization = 'Bearer ' + token();
    return fetch(apiUrl(path), {
      method: options.method || 'GET',
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      mode: 'cors',
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
    });
  }

  function navigate(path) {
    if (!path) path = '/';
    if (/^https?:\/\//i.test(path)) {
      window.location.href = path;
      return;
    }
    var clean = String(path).replace(/^\/+/, '');
    window.location.href = SITE_BASE + clean;
  }

  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function applyUser(nextUser) {
    user = nextUser || null;
    var authOnly = document.querySelectorAll('[data-auth-only]');
    var guestOnly = document.querySelectorAll('[data-guest-only]');
    Array.prototype.forEach.call(authOnly, function (el) {
      setHidden(el, !user);
    });
    Array.prototype.forEach.call(guestOnly, function (el) {
      setHidden(el, !!user);
    });
    var nameEl = document.querySelector('[data-auth-user]');
    if (nameEl && user) {
      nameEl.textContent = user.username;
      nameEl.setAttribute('href', SITE_BASE + 'u/' + encodeURIComponent(user.username) + '/');
    }

  }

  function showFormError(form, message, fields) {
    var box = form.parentNode.querySelector('[data-form-error]') || document.querySelector('[data-form-error]');
    if (!box) {
      box = document.createElement('div');
      box.className = 'notice notice-error';
      form.parentNode.insertBefore(box, form);
    }
    if (!message && fields) {
      message = Object.keys(fields)
        .map(function (k) {
          return fields[k];
        })
        .join('；');
    }
    box.textContent = message || '提交失败，请稍后再试';
    box.removeAttribute('hidden');
    box.setAttribute('role', 'alert');
  }

  function clearFormError(form) {
    var box = form.parentNode.querySelector('[data-form-error]');
    if (box) setHidden(box, true);
  }

  function serializeForm(form) {
    var fd = new FormData(form);
    var payload = {};
    fd.forEach(function (value, key) {
      if (key === 'models') {
        if (!payload.models) payload.models = [];
        payload.models.push(String(value));
        return;
      }
      if (key === 'accept') return;
      payload[key] = typeof value === 'string' ? value : String(value);
    });
    return payload;
  }

  function initForms() {
    var forms = document.querySelectorAll('[data-api-form]');
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        clearFormError(form);
        if (form.hasAttribute('data-auth-required') && !user) {
          navigate('/login/?next=' + encodeURIComponent(window.location.pathname));
          return;
        }
        var submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.dataset.label = submitBtn.textContent;
          submitBtn.textContent = '提交中…';
        }
        var endpoint = form.getAttribute('data-api-form');
        request(endpoint, { method: 'POST', body: serializeForm(form), auth: true })
          .then(function (res) {
            if (submitBtn) {
              submitBtn.disabled = false;
              if (submitBtn.dataset.label) submitBtn.textContent = submitBtn.dataset.label;
            }
            if (res.ok) {
              var redirect = res.data && res.data.redirect;
              if (redirect) navigate(redirect);
              else window.location.reload();
              return;
            }
            if (res.status === 401) {
              navigate('/login/?next=' + encodeURIComponent(window.location.pathname));
              return;
            }
            showFormError(form, (res.data && res.data.message) || '提交失败', res.data && res.data.fields);
          })
          .catch(function () {
            if (submitBtn) {
              submitBtn.disabled = false;
              if (submitBtn.dataset.label) submitBtn.textContent = submitBtn.dataset.label;
            }
            showFormError(form, '网络错误：无法连接到 API 服务');
          });
      });
    });
  }

  function initLogout() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-logout]'), function (btn) {
      btn.addEventListener('click', function () {
        request('auth/logout', { method: 'POST', auth: true }).catch(function () {});
        setToken('');
        applyUser(null);
        window.location.reload();
      });
    });
  }

  function initModelLimit() {
    var boxes = document.querySelectorAll('.model-option input[type="checkbox"]');
    if (!boxes.length) return;
    var max = 3;
    function refresh() {
      var checked = Array.prototype.filter.call(boxes, function (b) {
        return b.checked;
      }).length;
      Array.prototype.forEach.call(boxes, function (b) {
        b.disabled = !b.checked && checked >= max;
      });
      var hint = document.querySelector('[data-model-count]');
      if (hint) hint.textContent = checked + ' / ' + max;
    }
    Array.prototype.forEach.call(boxes, function (b) {
      b.addEventListener('change', refresh);
    });
    refresh();
  }

  function initSearch() {
    var form = document.querySelector('[data-search-form]');
    if (!form) return;
    var resultsBox = document.querySelector('[data-search-results]');
    var metaBox = document.querySelector('[data-search-meta]');
    var input = form.querySelector('input[name="q"]');

    function run(q) {
      if (!q) {
        resultsBox.innerHTML = '';
        if (metaBox) metaBox.textContent = '输入关键词开始检索。';
        return;
      }
      if (metaBox) metaBox.textContent = '搜索中…';
      request('search?q=' + encodeURIComponent(q) + '&page_size=20')
        .then(function (res) {
          resultsBox.innerHTML = '';
          if (!res.ok) {
            if (metaBox) metaBox.textContent = (res.data && res.data.message) || '搜索失败';
            return;
          }
          var items = (res.data && res.data.results) || [];
          var total = (res.data && res.data.pagination && res.data.pagination.total) || 0;
          if (metaBox) metaBox.textContent = '共 ' + total + ' 条结果' + (total > items.length ? '（显示前 ' + items.length + ' 条）' : '');
          if (!items.length) {
            var empty = document.createElement('div');
            empty.className = 'empty-state';
            var h = document.createElement('h2');
            h.textContent = '没有找到与「' + q + '」相关的内容';
            var p = document.createElement('p');
            p.textContent = '试试更短的关键词，或直接浏览板块。';
            empty.appendChild(h);
            empty.appendChild(p);
            resultsBox.appendChild(empty);
            return;
          }
          var ul = document.createElement('ul');
          ul.className = 'thread-list';
          items.forEach(function (t) {
            var li = document.createElement('li');
            li.className = 'thread-item';
            var a = document.createElement('a');
            a.className = 'thread-row';
            a.href = SITE_BASE + String(t.path).replace(/^\/+/, '');
            var main = document.createElement('span');
            main.className = 'thread-main';
            var tags = document.createElement('span');
            tags.className = 'thread-tags';
            var cat = document.createElement('span');
            cat.className = 'tag';
            cat.textContent = t.category_name || t.category;
            tags.appendChild(cat);
            (t.model_labels || []).forEach(function (label) {
              var chip = document.createElement('span');
              chip.className = 'tag tag-model';
              chip.textContent = label;
              tags.appendChild(chip);
            });
            var title = document.createElement('span');
            title.className = 'thread-title';
            title.textContent = t.title;
            var meta = document.createElement('span');
            meta.className = 'thread-meta';
            meta.textContent = t.author + ' · ' + (t.reply_count || 0) + ' 回复';
            var snip = document.createElement('span');
            snip.className = 'result-snippet';
            snip.textContent = t.excerpt || '';
            main.appendChild(tags);
            main.appendChild(title);
            main.appendChild(meta);
            main.appendChild(snip);
            a.appendChild(main);
            li.appendChild(a);
            ul.appendChild(li);
          });
          resultsBox.appendChild(ul);
        })
        .catch(function () {
          if (metaBox) metaBox.textContent = '网络错误：无法连接到 API 服务';
        });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var q = input ? input.value.trim() : '';
      var url = new URL(window.location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url.toString());
      run(q);
    });
    var initial = new URL(window.location.href).searchParams.get('q') || '';
    if (initial && input) {
      input.value = initial;
      run(initial);
    }
  }

  function initViewBeacon() {
    var threadId = document.body.getAttribute('data-thread-id');
    if (!threadId) return;
    var key = 'pojia_view_' + threadId;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (e) {}
    request('threads/' + encodeURIComponent(threadId) + '/view', { method: 'POST' }).then(function (res) {
      if (res.ok && res.data && typeof res.data.views === 'number') {
        var el = document.querySelector('[data-view-count]');
        if (el) el.textContent = String(res.data.views);
      }
    }).catch(function () {});
  }

  function renderDynamicCategory(slug, box, hint) {
    Promise.all([request('categories'), request('threads?category=' + encodeURIComponent(slug) + '&page_size=20')])
      .then(function (results) {
        var catRes = results[0];
        var listRes = results[1];
        if (!catRes.ok) return;
        var cat = (catRes.data.categories || []).filter(function (c) {
          return c.slug === slug;
        })[0];
        if (!cat) return;
        box.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'dynamic-note';
        head.textContent = '该板块尚未进入静态构建，以下内容实时从 API 读取；下一次构建后成为正式页面。';
        var title = document.createElement('h2');
        title.className = 'dynamic-title';
        title.textContent = cat.name;
        var desc = document.createElement('p');
        desc.className = 'hint';
        desc.textContent = cat.description || '自建板块';
        box.appendChild(head);
        box.appendChild(title);
        box.appendChild(desc);
        var threads = (listRes.ok && listRes.data.threads) || [];
        if (!threads.length) {
          var empty = document.createElement('p');
          empty.className = 'hint';
          empty.textContent = '这个板块还没有主题。';
          box.appendChild(empty);
        } else {
          var ul = document.createElement('ul');
          ul.className = 'thread-list';
          threads.forEach(function (t) {
            var li = document.createElement('li');
            li.className = 'thread-item';
            var a = document.createElement('a');
            a.className = 'thread-row';
            a.href = SITE_BASE + String(t.path).replace(/^\/+/, '');
            var main = document.createElement('span');
            main.className = 'thread-main';
            var titleEl = document.createElement('span');
            titleEl.className = 'thread-title';
            titleEl.textContent = t.title;
            var meta = document.createElement('span');
            meta.className = 'thread-meta';
            meta.textContent = t.author + ' · ' + (t.reply_count || 0) + ' 回复';
            main.appendChild(titleEl);
            main.appendChild(meta);
            a.appendChild(main);
            li.appendChild(a);
            ul.appendChild(li);
          });
          box.appendChild(ul);
        }
        setHidden(box, false);
        if (hint) setHidden(hint, true);
      })
      .catch(function () {});
  }

  function initDynamicFallback() {
    if (document.body.getAttribute('data-page') !== '404') return;
    var box = document.querySelector('[data-dynamic-fallback]');
    var hint = document.querySelector('[data-dynamic-hint]');
    if (!box) return;
    var pathname = window.location.pathname;
    if (SITE_BASE !== '/' && pathname.indexOf(SITE_BASE) === 0) pathname = pathname.slice(SITE_BASE.length - 1);
    var mc = /^\/c\/([a-z0-9][a-z0-9-]*)\/?$/.exec(pathname);
    if (mc) {
      renderDynamicCategory(mc[1], box, hint);
      return;
    }
    var m = /^\/t\/(\d+)(?:-[^/]+)?\/?$/.exec(pathname);
    if (!m) return;
    request('threads/' + m[1])
      .then(function (res) {
        if (!res.ok) return;
        var t = res.data.thread;
        box.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'dynamic-note';
        head.textContent = '该主题尚未进入静态构建，以下内容实时从 API 读取；下一次构建后会成为正式静态页面。';
        var title = document.createElement('h2');
        title.className = 'dynamic-title';
        title.textContent = t.title;
        var meta = document.createElement('p');
        meta.className = 'hint';
        meta.textContent = t.author + ' · ' + t.category_name + ' · ' + (t.model_labels || []).join('、');
        var body = document.createElement('div');
        body.className = 'dynamic-body';
        String(t.body || '')
          .split(/\n{2,}/)
          .forEach(function (para) {
            var p = document.createElement('p');
            p.textContent = para;
            body.appendChild(p);
          });
        box.appendChild(head);
        box.appendChild(title);
        box.appendChild(meta);
        box.appendChild(body);
        setHidden(box, false);
        if (hint) setHidden(hint, true);
      })
      .catch(function () {});
  }

  function boot() {
    initForms();
    initLogout();
    initModelLimit();
    initSearch();
    initViewBeacon();
    initDynamicFallback();
    if (token()) {
      request('auth/me', { auth: true }).then(function (res) {
        if (res.ok && res.data && res.data.user) applyUser(res.data.user);
        else {
          if (res.status === 401) setToken('');
          applyUser(null);
        }
      }).catch(function () {
        applyUser(null);
      });
    } else {
      applyUser(null);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
