import "./vendor/jquery-3.7.1.min.js";
import "./vendor/js.cookie.min.js";
import "./vendor/commonmark.js";
import "./vendor/purify.min.js";
import * as smd from "./vendor/smd.min.js";
import Info from "./info.js";

jQuery(document).ready(function($) {

    var endpoint = 'https://vectorseek.ai';
    if ($('#vectorseek').data('env') == 'dev') {
        endpoint = 'http://localhost:8200';
    }

    function waitForSocketConnection(socket, callback){
        setTimeout(
            function () {
                if (socket.readyState === 1) {
                    console.log("Connected.")
                    if (callback != null){
                        callback();
                    }
                } else {
                    console.log("waiting for connection...")
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
        var host = 'vectorseek.ai';
        var token = $('#vectorseek').data('key');
        if (!token) {
            token = $('#vectorseek').attr('data-key');
        }

        var proto = 'wss://';
        if ($('#vectorseek').data('env') == 'dev') {
            console.log("Env: " + $('#vectorseek').data('env'));
            host = 'localhost:8200';
            proto = 'ws://';
        }

        const context = 20;
        var message = '';
        var url = proto + host + '/ws/project/' + token;
        console.log("URL: " + url);

        const chatSocket = new WebSocket( url );

        // var reader = new commonmark.Parser({smart: true});
        // var writer = new commonmark.HtmlRenderer({safe: false, softbreak: "<br/>"});

        const element  = document.getElementById("vectorseek_results");
        // const renderer = smd.default_renderer(element);
        // const parser   = smd.parser(renderer);

        var renderer = null;
        var parser = null;

        chatSocket.onmessage = function(e) {

            if (!parser || !renderer) {
                renderer = smd.default_renderer(element);
                parser   = smd.parser(renderer);
            }

            $('#vectorseek_loader-container').css('display', 'none');
            const data = JSON.parse(e.data);

            message += data.message;

            DOMPurify.sanitize(message);

            if (DOMPurify.removed.length) {
                console.log("Found insecure code");
                smd.parser_end(parser);
            } else {
                // console.log(data);
                if (data.message) {
                    smd.parser_write(parser, data.message);
                }

                // if (data.message) {
                //     var parsed = reader.parse(message);
                //     var result = writer.render(parsed);
                //     $('#vectorseek_results').html(result);
                // }

                if (data.sources && data.sources.length > 0) {
                    let citationsHtml = '<div class="citations"><h5>Sources:</h5>';
                    data.sources.forEach(function(source, index) {
                        const citationNum = index + 1;
                        const confidence = getConfidenceClass(source.confidence);
                        citationsHtml += `<div class="row mb-1 p-1 ${confidence}">
                            <div class="col small text-muted">
                            <span class="citation-number">${citationNum} - </span>
                            <span class="confidence">${(source.confidence * 100).toFixed(0)}% - </span>
                            <span class="citation-link"><a href="${source.url}" target="_blank">${source.title}</a></span>
                            </div>
                        </div>`;
                    });
                    citationsHtml += '</div>';
                    $("#vectorseek_results").append(citationsHtml);
                }

                if (data.contexts) {
                    $('#vectorseek_context').append('<div class="row pt-3 pb-3"><b>Context:</b></div>');
                    data.contexts.forEach(function(c) {
                        $("#vectorseek_context").append('<div class="col pb-2">' + c + '</div>');
                    });

                    $('#vectorseek_rate').removeClass('d-none');
                }

                if (data.qlog_id) {
                    smd.parser_end(parser);
                    $('#qlog_id').val(data.qlog_id);
                }
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
                var client = 'js';
                ip.then(ip => {
                    i['ip'] = ip;
                    chatSocket.send(JSON.stringify({'type': 'query', 'uuid': uuid, 'query': query, 'context': context, 'info': i, 'client': client}));
                }).catch(err => {
                    console.log(err);
                    chatSocket.send(JSON.stringify({'type': 'query', 'uuid': uuid, 'query': query, 'context': context, 'info': info, 'client': client}));
                });

            });
        });

    }

    websocket_setup();

    function getConfidenceClass(confidence) {
        if (confidence >= 0.85) return 'conf-excellent';  // Green - Excellent
        if (confidence >= 0.70) return 'conf-good';  // Light Green - Good
        if (confidence >= 0.60) return 'conf-fair';  // Yellow - Fair
        if (confidence >= 0.40) return 'conf-poor'; // Orange - Poor
        return 'conf-verypoor'; // Red - Very Poor
    }

});
