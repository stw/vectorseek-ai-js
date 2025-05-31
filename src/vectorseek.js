import "./jquery-3.7.1.min.js";
import "./js.cookie.min.js";
import "./commonmark.js";
import Info from "./info.js";

jQuery(document).ready(function($) {

    const endpoint = 'https://vectorseek.ai';

    function waitForSocketConnection(socket, callback){
        setTimeout(
            function () {
                if (socket.readyState === 1) {
                    console.log("Connection is made")
                    if (callback != null){
                        callback();
                    }
                } else {
                    console.log("wait for connection...")
                    waitForSocketConnection(socket, callback);
                }

            }, 5); // wait 5 milisecond for the connection...
    }

    function urlify(text) {
      var urlRegex = /(https?:\/\/[^\s]+)/g;
      return text.replace(urlRegex, function(url) {
        return '<a href="' + url + '">' + url + '</a>';
      })
    }

    function uuidv4() {
      return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
        (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16)
      );
    }

    function websocket_setup(data) {
        const host = 'vectorseek.ai';
        var token = $('#vectorseek').data('key');
        if (!token) {
            token = $('#vectorseek').attr('data-key');
        }
        const context = 10;
        var message = '';
        var proto = 'wss://';
        var url = proto + host + '/ws/project/' + token;

        const chatSocket = new WebSocket( url );

        var reader = new commonmark.Parser();
        var writer = new commonmark.HtmlRenderer();

        chatSocket.onmessage = function(e) {
            const data = JSON.parse(e.data);

            message += data.message;

            $('#vectorseek_loader-container').css('display', 'none');

            if (data.message) {
                var parsed = reader.parse(message);
                var result = writer.render(parsed);
                $('#vectorseek_results').html(result);
            }

            if (data.contexts) {
                $('#vectorseek_context').append('<div class="row pt-3 pb-3"><b>Context:</b></div>');
                data.contexts.forEach(function(c) {
                    $("#vectorseek_context").append('<div class="col pb-2">' + c + '</div>');
                });

                $('#vectorseek_rate').removeClass('d-none');
            }

            if (data.qlog_id) {
                $('#qlog_id').val(data.qlog_id);
            }

        };

        chatSocket.onclose = function(e) {
            console.log('Chat Socket Closed Unexpectedly');
            $('#vectorseek_query_row').hide();
            $('#vectorseek_error').html('<b>Connection failed, please <a href=".">refresh the page</a> and try again.</p>');
        };

        $('#vectorseek_up').on('click', function(e) {
            var id = $('#qlog_id').val();
            $.ajax({
                url: endpoint + '/api/query/' + id + '/up',
                type: 'GET',
                crossDomain: true,
                dataType: 'jsonp',
            });
            $('#vectorseek_rate').html('<div id="vs_msg"><b>Thank You!</b></div>');
            $('#vectorseek_rating').addClass('d-none');
        });

        $('#vectorseek_down').on('click', function(e) {
            var id = $('#qlog_id').val();
            $.ajax({
                url: endpoint + '/api/query/' + id + '/down',
                type: 'GET',
                crossDomain: true,
                dataType: 'jsonp'
            });
            $('#vectorseek_rate').html('<div id="vs_msg"><b>Thank You!</b></div>');
            $('#vectorseek_rating').addClass('d-none');
        });

        $(document).on('click', '#vectorseek_submit', function(e) {
            e.preventDefault();
            var query = $('#vectorseek_query').val();
            var context = 10;
            var uuid = Cookies.get('uuid');
            if (! uuid) {
                uuid = uuidv4();
                Cookies.set('uuid', uuid);
            }
            message = '';
            $('#vectorseek_results').empty();
            $('#vectorseek_loader-container').css('display', 'flex');
            $('#vectorseek_rate').addClass('d-none');
            $('#vs_msg').remove();
            $('#vectorseek_rating').removeClass('d-none');
            $('#accordionContext').addClass('d-none');

            waitForSocketConnection(chatSocket, function(){

                var info = new Info();
                var i = info.info();
                var ip = info.ip();
                ip.then(ip => {
                    i['ip'] = ip;
                    chatSocket.send(JSON.stringify({'type': 'query', 'uuid': uuid, 'query': query, 'context': context, 'info': i}));
                }).catch(err => {
                    console.log(err);
                    chatSocket.send(JSON.stringify({'type': 'query', 'uuid': uuid, 'query': query, 'context': context, 'info': info}));
                });

            });
        });

    }

    websocket_setup();

});
