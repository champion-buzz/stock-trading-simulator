/* global angular */
angular
  .module('stockSim')

  // ------------------------------------------------------------ auth/session
  .factory('Auth', ['$window', '$http', function ($window, $http) {
    var KEY = 'stocksim.session';
    var saved = null;
    try { saved = JSON.parse($window.localStorage.getItem(KEY)); } catch (e) { saved = null; }

    var Auth = {
      token: saved && saved.token,
      user: saved && saved.user,
      isLoggedIn: function () { return !!Auth.token; },
      save: function (res) {
        Auth.token = res.token;
        Auth.user = res.user;
        try { $window.localStorage.setItem(KEY, JSON.stringify(res)); } catch (e) { /* storage unavailable */ }
      },
      login: function (username, password) {
        return $http.post('/api/auth/login', { username: username, password: password })
          .then(function (r) { Auth.save(r.data); return r.data; });
      },
      register: function (username, password) {
        return $http.post('/api/auth/register', { username: username, password: password })
          .then(function (r) { Auth.save(r.data); return r.data; });
      },
      logout: function () {
        Auth.token = null;
        Auth.user = null;
        try { $window.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      },
    };
    return Auth;
  }])

  .factory('AuthInterceptor', ['$injector', '$q', '$location', function ($injector, $q, $location) {
    return {
      request: function (config) {
        var Auth = $injector.get('Auth');
        if (Auth.token && config.url.indexOf('/api/') === 0) {
          config.headers.Authorization = 'Bearer ' + Auth.token;
        }
        return config;
      },
      responseError: function (res) {
        if (res.status === 401 && res.config.url.indexOf('/api/auth/') !== 0) {
          $injector.get('Auth').logout();
          $location.path('/login');
        }
        return $q.reject(res);
      },
    };
  }])

  // ------------------------------------------------------------ REST API
  .factory('Api', ['$http', function ($http) {
    var data = function (r) { return r.data; };
    return {
      quotes: function () { return $http.get('/api/stocks').then(data); },
      quote: function (s) { return $http.get('/api/stocks/' + s).then(data); },
      history: function (s, range) { return $http.get('/api/stocks/' + s + '/history', { params: { range: range } }).then(data); },
      portfolio: function () { return $http.get('/api/portfolio').then(data); },
      trade: function (symbol, side, quantity) {
        return $http.post('/api/trades', { symbol: symbol, side: side, quantity: quantity }).then(data);
      },
      transactions: function (params) { return $http.get('/api/transactions', { params: params }).then(data); },
    };
  }])

  // ------------------------------------------------------------ live quotes (SSE)
  .factory('MarketStream', ['$rootScope', '$timeout', function ($rootScope, $timeout) {
    var stream = { quotes: {}, connected: false, source: null };
    var listeners = [];

    function apply(q) {
      var prev = stream.quotes[q.symbol];
      q.dir = prev ? (q.price > prev.price ? 'up' : q.price < prev.price ? 'down' : prev.dir) : '';
      q.flash = prev && q.price !== prev.price;
      stream.quotes[q.symbol] = q;
    }

    stream.connect = function () {
      if (stream.source) return;
      var es = new EventSource('/api/stream');
      stream.source = es;
      es.addEventListener('open', function () { $rootScope.$applyAsync(function () { stream.connected = true; }); });
      es.addEventListener('error', function () { $rootScope.$applyAsync(function () { stream.connected = false; }); });
      es.addEventListener('snapshot', function (e) {
        $rootScope.$applyAsync(function () { JSON.parse(e.data).forEach(apply); });
      });
      es.addEventListener('tick', function (e) {
        var q = JSON.parse(e.data);
        $rootScope.$applyAsync(function () {
          apply(q);
          listeners.forEach(function (fn) { fn(q); });
        });
        $timeout(function () { if (stream.quotes[q.symbol]) stream.quotes[q.symbol].flash = false; }, 400);
      });
    };

    stream.onTick = function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    };

    stream.list = function () {
      return Object.keys(stream.quotes).sort().map(function (k) { return stream.quotes[k]; });
    };

    return stream;
  }]);
