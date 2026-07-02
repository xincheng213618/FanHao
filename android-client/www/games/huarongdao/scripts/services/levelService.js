'use strict';

/**
 *
 */

angular.module('GameApp')
.service('LevelService', function ($http, $q) {

  var dataUrl = 'data/levels.json';

  /**
   *
   */
  this.getLevelData = function () {
    var deferred = $q.defer();

    var self = this;

    $http.get(dataUrl)
      .then(function (response) {
        var res = self.processData(response.data);
        deferred.resolve(res);
      }, function () {
        deferred.reject('There was an error');
      });

    return deferred.promise;
  };

  /**
   *
   */
  this.processData = function (data) {
    if (angular.isArray(data)) {
      var i;

      for (i = 0; i < data.length; i++) {
        var tiles = data[i].tiles;

        if (angular.isArray(tiles)) {
          for (var j = 0; j < tiles.length; j++) {
            tiles[j].id = j;
          }
        }
      }

      return data;
    }
  };

});
