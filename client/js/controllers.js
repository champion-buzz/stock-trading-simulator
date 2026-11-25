/* global angular, Chart */
angular
  .module('stockSim')

  .controller('ShellCtrl', ['Auth', 'MarketStream', '$location', function (Auth, MarketStream, $location) {
    var vm = this;
    vm.auth = Auth;
    vm.stream = MarketStream;
    if (Auth.isLoggedIn()) MarketStream.connect();
    vm.is = function (path) { return $location.path() === path; };
    vm.logout = function () { Auth.logout(); $location.path('/login'); };
  }])

  .controller('LoginCtrl', ['Auth', 'MarketStream', '$location', function (Auth, MarketStream, $location) {
    var vm = this;
    vm.mode = 'login';
    vm.form = { username: '', password: '' };
    vm.submit = function () {
      vm.error = null;
      vm.busy = true;
      var call = vm.mode === 'login' ? Auth.login : Auth.register;
      call(vm.form.username, vm.form.password)
        .then(function () { MarketStream.connect(); $location.path('/'); })
        .catch(function (res) {
          var err = res.data && res.data.error;
          vm.error = err ? err.message : 'Request failed';
          vm.details = err && err.details;
        })
        .finally(function () { vm.busy = false; });
    };
  }])

  // Shared trade ticket logic used by the market and stock pages.
  .factory('TradeTicket', ['Api', function (Api) {
    return function () {
      var t = { side: 'BUY', quantity: 1, busy: false, message: null, error: null };
      t.submit = function (symbol, onDone) {
        t.busy = true;
        t.message = t.error = null;
        Api.trade(symbol, t.side, t.quantity)
          .then(function (res) {
            var tx = res.transaction;
            t.message = (tx.side === 'BUY' ? 'Bought ' : 'Sold ') + tx.quantity + ' ' + tx.symbol +
              ' @ $' + tx.price.toFixed(2) + (tx.side === 'SELL' ? ' (P&L ' + tx.realizedPnl.toFixed(2) + ')' : '');
            if (onDone) onDone(tx);
          })
          .catch(function (res) {
            var e = res.data && res.data.error;
            t.error = e ? (e.details ? e.details.map(function (d) { return d.message; }).join(', ') : e.message) : 'Trade failed';
          })
          .finally(function () { t.busy = false; });
      };
      return t;
    };
  }])

  .controller('MarketCtrl', ['MarketStream', 'TradeTicket', 'Api', function (MarketStream, TradeTicket, Api) {
    var vm = this;
    vm.stream = MarketStream;
    vm.ticket = TradeTicket();
    vm.selected = null;
    vm.select = function (q) {
      vm.selected = q.symbol;
      vm.ticket.message = vm.ticket.error = null;
    };
    vm.refreshCash = function () { Api.portfolio().then(function (p) { vm.cash = p.cash; }); };
    vm.refreshCash();
  }])

  .controller('StockCtrl', ['$routeParams', '$scope', '$timeout', 'Api', 'MarketStream', 'TradeTicket',
    function ($routeParams, $scope, $timeout, Api, MarketStream, TradeTicket) {
      var vm = this;
      var chart = null;
      var live = null;
      vm.symbol = $routeParams.symbol.toUpperCase();
      vm.stream = MarketStream;
      vm.ticket = TradeTicket();
      vm.range = '6M';
      vm.ranges = ['1M', '3M', '6M', '1Y'];

      function draw(bars) {
        var canvas = document.getElementById('historyChart');
        if (!canvas) return;
        if (chart) chart.destroy();
        chart = new Chart(canvas, {
          type: 'line',
          data: {
            labels: bars.map(function (b) { return b.date; }),
            datasets: [
              { label: 'Close', data: bars.map(function (b) { return b.close; }), borderColor: '#0d6efd', borderWidth: 2, pointRadius: 0, tension: 0.1 },
              { label: 'SMA 20', data: bars.map(function (b) { return b.sma20; }), borderColor: '#fd7e14', borderWidth: 1, pointRadius: 0 },
              { label: 'SMA 50', data: bars.map(function (b) { return b.sma50; }), borderColor: '#6f42c1', borderWidth: 1, pointRadius: 0 },
            ],
          },
          options: {
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: { x: { ticks: { maxTicksLimit: 8 } } },
            plugins: { legend: { position: 'bottom' } },
          },
        });
      }

      function drawLive() {
        var canvas = document.getElementById('liveChart');
        if (!canvas) return;
        live = new Chart(canvas, {
          type: 'line',
          data: { labels: [], datasets: [{ label: 'Live', data: [], borderColor: '#198754', borderWidth: 2, pointRadius: 0 }] },
          options: { animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false } } },
        });
      }

      vm.load = function (range) {
        vm.range = range;
        Api.history(vm.symbol, range).then(function (h) {
          vm.stats = h.stats;
          vm.lastRsi = h.bars.length ? h.bars[h.bars.length - 1].rsi14 : null;
          draw(h.bars);
        }).catch(function () { vm.notFound = true; });
      };

      vm.loadPosition = function () {
        Api.portfolio().then(function (p) {
          vm.cash = p.cash;
          vm.position = p.positions.filter(function (x) { return x.symbol === vm.symbol; })[0] || null;
        });
      };

      vm.quote = function () { return MarketStream.quotes[vm.symbol]; };

      var unsubscribe = MarketStream.onTick(function (q) {
        if (q.symbol !== vm.symbol || !live) return;
        var d = live.data;
        d.labels.push(new Date(q.ts).toLocaleTimeString());
        d.datasets[0].data.push(q.price);
        if (d.labels.length > 120) { d.labels.shift(); d.datasets[0].data.shift(); }
        live.update('none');
      });

      // wait one digest so the canvases are in the DOM
      $timeout(function () {
        drawLive();
        vm.load(vm.range);
      });
      $scope.$on('$destroy', function () {
        unsubscribe();
        if (chart) chart.destroy();
        if (live) live.destroy();
      });
      vm.loadPosition();
    }])

  .controller('PortfolioCtrl', ['Api', 'MarketStream', '$scope', function (Api, MarketStream, $scope) {
    var vm = this;
    vm.load = function () {
      Api.portfolio().then(function (p) { vm.p = p; recompute(); });
    };

    // revalue positions client-side on every tick so the page is live
    function recompute() {
      if (!vm.p) return;
      var invested = 0;
      vm.p.positions.forEach(function (pos) {
        var q = MarketStream.quotes[pos.symbol];
        if (q) pos.price = q.price;
        pos.marketValue = pos.quantity * pos.price;
        pos.unrealizedPnl = pos.marketValue - pos.costBasis;
        pos.unrealizedPnlPct = pos.costBasis ? (pos.unrealizedPnl / pos.costBasis) * 100 : 0;
        invested += pos.marketValue;
      });
      vm.p.invested = invested;
      vm.p.totalValue = vm.p.cash + invested;
      vm.p.totalReturnPct = ((vm.p.totalValue - vm.p.startingCash) / vm.p.startingCash) * 100;
      vm.p.positions.forEach(function (pos) { pos.weightPct = (pos.marketValue / vm.p.totalValue) * 100; });
    }

    var unsubscribe = MarketStream.onTick(recompute);
    $scope.$on('$destroy', unsubscribe);
    vm.load();
  }])

  .controller('TransactionsCtrl', ['Api', function (Api) {
    var vm = this;
    vm.limit = 20;
    vm.skip = 0;
    vm.symbol = '';
    vm.load = function (skip) {
      vm.skip = Math.max(0, skip || 0);
      var params = { limit: vm.limit, skip: vm.skip };
      if (vm.symbol) params.symbol = vm.symbol.toUpperCase();
      Api.transactions(params).then(function (r) { vm.items = r.items; vm.total = r.total; });
    };
    vm.load(0);
  }]);
