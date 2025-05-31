import { THUMBS_UP, THUMBS_DOWN, styles } from "./assets.js";
import "./vectorseek.js";

class VectorSeekWidget {
    constructor() {
        this.initialize();
    }

    widgetContent = null;

    async initialize() {
        const styleTag = document.createElement("style");
        styleTag.innerHTML = styles.replace(/^\s+|\n/gm, "");
        document.head.appendChild(styleTag);
        const container = document.createElement("div");
        container.style.width = "95%";
        this.widgetContainer = document.createElement("div");
        var el = document.getElementById('vectorseek');
        el.prepend(container);
        this.createWidgetContent();
        container.appendChild(this.widgetContainer);
    }

    createWidgetContent() {
        this.widgetContainer.innerHTML = `
        <section id="vectorseek_querybox" class="vs-section">
          <div class="container-1100">
            <div class="vs-row">
              <div class="vs-col">

                <form>
                    <div class="vs-row">
                        <div class="vs-col vs-mb-3">
                            <textarea id="vectorseek_query" class="vs-form-control" name="query" cols="80" rows="2" placeholder="Ask a question..."></textarea>
                        </div>

                        <div class="vs-col vs-mb-3">
                            <button id="vectorseek_submit" type="button" class="vs-btn vs-btn-outline-primary">
                                <span class="text">Submit</span>
                            </button>
                        </div>
                    </div>
                </form>

                <div id="vectorseek_loader-container" class="vs-mt-3">
                    <div class="vectorseek_loader-bar"></div>
                    <div class="vectorseek_loader-bar"></div>
                    <div class="vectorseek_loader-bar"></div>
                </div> 

                <div id="chat_error" class="vs-row vs-mb-3 d-none">
                    <div class="vs-col">
                        <div class="message message-danger">
                        An error has occurred, <a href=".">please try again</a>.
                        </div>
                    </div>
                </div>

                <div id="vectorseek_results" class="vs-mb-3" aria-live="polite">
                </div>

              </div>
            </div>

            <div class="vs-row vs-mb-3">
              <div class="vs-col">
                <div class="vs-row">
                  <div class="vs-col-6">
                    <div id="vectorseek_rate" class="vectorseek_rate d-none">
                      <div class="vectorseek_ratetext">
                        <p>AI results. Please confirm accuracy.<br>
                        Was this answer helpful?</p>
                      </div>
                      <div id="vectorseek_rating">
                        <input type="hidden" name="qlog_id" id="qlog_id" value=""/>
                        <a id="vectorseek_up" href="#"><img src="https://vectorseek.ai/static/images/thumb-up.svg" alt="Thumbs Up" class="vectorseek_thumbs_up" role="button" tabindex="0"/></a>
                        <a id="vectorseek_down" href="#"><img src="https://vectorseek.ai/static/images/thumb-down.svg" alt="Thumbs Down" class="vectorseek_thumbs_down" role="button" tabindex="0"/></a>
                      </div>
                    </div>
                  </div>
                  <div class="vs-col-6 float-end">
                    <div class="vectorseek_pb">
                      AI search powered by <a href="https://VectorSeek.ai" target="_blank" rel="noopener noreferrer">VectorSeek.ai</a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
`;
    }
}

function initializeWidget() {
  return new VectorSeekWidget();
}

initializeWidget();

