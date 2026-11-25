/* global angular */
angular
  .module('stockSim', ['ngRoute'])
  .config(['$routeProvider', '$httpProvider', function ($routeProvider, $httpProvider) {
    var requireLogin = {
      auth: ['Auth', '$location', '$q', function (Auth, $location, $q) {
        if (Auth.isLoggedIn()) return true;
        $location.path('/login');
        return $q.reject('not logged in');
      }],
    };
    $routeProvider
      .when('/login', { templateUrl: 'views/login.html', controller: 'LoginCtrl', controllerAs: 'vm' })
      .when('/', { templateUrl: 'views/market.html', controller: 'MarketCtrl', controllerAs: 'vm', resolve: requireLogin })
      .when('/stock/:symbol', { templateUrl: 'views/stock.html', controller: 'StockCtrl', controllerAs: 'vm', resolve: requireLogin })
      .when('/portfolio', { templateUrl: 'views/portfolio.html', controller: 'PortfolioCtrl', controllerAs: 'vm', resolve: requireLogin })
      .when('/transactions', { templateUrl: 'views/transactions.html', controller: 'TransactionsCtrl', controllerAs: 'vm', resolve: requireLogin })
      .otherwise('/');

    $httpProvider.interceptors.push('AuthInterceptor');
  }])
  .filter('signed', function () {
    return function (n, digits) {
      if (n == null || isNaN(n)) return '—';
      var d = digits == null ? 2 : digits;
      return (n > 0 ? '+' : '') + Number(n).toFixed(d);
    };
  });
