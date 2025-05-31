export default class Info {
    constructor() {
        this.i = {
            timeOpened:new Date(),
            timezone:(new Date()).getTimezoneOffset()/60,

            onPage(){return window.location.pathname},
            referrer(){return document.referrer},
            previousSites(){return history.length},

            browserName(){return navigator.appName},
            browserEngine(){return navigator.product},
            browserVersion1a(){return navigator.appVersion},
            browserVersion1b(){return navigator.userAgent},
            browserLanguage(){return navigator.language},
            browserOnline(){return navigator.onLine},
            browserPlatform(){return navigator.platform},
            javaEnabled(){return navigator.javaEnabled()},
            dataCookiesEnabled(){return navigator.cookieEnabled},
            dataCookies1(){return document.cookie},
            dataCookies2(){return decodeURIComponent(document.cookie.split(";"))},
            dataStorage(){return localStorage},

            sizeScreenW(){return screen.width},
            sizeScreenH(){return screen.height},
            sizeDocW(){return document.width},
            sizeDocH(){return document.height},
            sizeInW(){return innerWidth},
            sizeInH(){return innerHeight},
            sizeAvailW(){return screen.availWidth},
            sizeAvailH(){return screen.availHeight},
            scrColorDepth(){return screen.colorDepth},
            scrPixelDepth(){return screen.pixelDepth},


            latitude(){return position.coords.latitude},
            longitude(){return position.coords.longitude},
            accuracy(){return position.coords.accuracy},
            altitude(){return position.coords.altitude},
            altitudeAccuracy(){return position.coords.altitudeAccuracy},
            heading(){return position.coords.heading},
            speed(){return position.coords.speed},
            timestamp(){return position.timestamp},

            async ip() {
                const ip = await getIP();
                return ip;
            },
        };
    }

    async ip() {
        try {
            const response = await fetch('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        } catch (error) {
            console.error('Error fetching IP address:', error);
        }
    }

    info() {
        return {
            'page': this.i.onPage(),
            'referrer': this.i.referrer(),
            'broswer': this.i.browserName(),
            'version1a': this.i.browserVersion1a(),
            'version1b': this.i.browserVersion1b(),
            'engine': this.i.browserEngine(),
            'platform': this.i.browserPlatform(),
            'language': this.i.browserLanguage(),
            'size_w': this.i.sizeScreenW(),
            'size_h': this.i.sizeScreenH(),
            'avail_w': this.i.sizeAvailW(),
            'avail_h': this.i.sizeAvailH(),
            'in_w': this.i.sizeInW(),
            'in_h': this.i.sizeInH()
        };
    }
}

