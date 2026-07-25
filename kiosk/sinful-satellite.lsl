// ============================================================
// Sinful Newsletter Satellite v1.0
// Lightweight signup point for the Sinful Newsletter Hub.
//
// Place these anywhere — other parcels, other sims. They do
// three things only: Subscribe, Unsubscribe, Get Latest.
// No items go inside; "Get Latest" is relayed to the server,
// and your PRIMARY kiosk delivers the actual package to the
// resident cross-region within moments.
//
// SETUP: set SERVER_URL and TOKEN (same TOKEN as the primary
// kiosk / KIOSK_TOKEN in the server env). Give each satellite
// its own LABEL — signups show it as their source in the
// dashboard. Optionally pin LIST_NAME so subscribing here
// auto-joins that list (e.g. a "Beach Events" board at the
// beach); leave "" to offer the normal list picker.
// ============================================================

// ---- Configuration -----------------------------------------
string  SERVER_URL      = "https://sinful-newsletter.vercel.app"; // no trailing slash
string  TOKEN           = "change-me-too";
string  NEWSLETTER_NAME = "Sinful Newsletter";
string  LABEL           = "Satellite";  // shown as signup source (max 24 chars)
string  LIST_NAME       = "";           // "" = offer picker; or e.g. "Beach Events"
float   HEARTBEAT       = 300.0;

// ---- State -------------------------------------------------
list    g_http;         // strided [request_id, type, aux]
integer g_lastHello;
integer g_dlgChan;

// ============================================================

req(string method, string path, string body, string type, string aux)
{
    key id = llHTTPRequest(SERVER_URL + "/api/kiosk" + path,
        [HTTP_METHOD, method,
         HTTP_MIMETYPE, "application/json",
         HTTP_CUSTOM_HEADER, "X-Kiosk-Token", TOKEN,
         HTTP_BODY_MAXLENGTH, 16384],
        body);
    if (id == NULL_KEY)
    {
        if (type == "event") queueOutbox(aux);
        return;
    }
    g_http += [id, type, aux];
}

queueOutbox(string json)
{
    integer n = (integer)llLinksetDataRead("outn") + 1;
    llLinksetDataWrite("outn", (string)n);
    llLinksetDataWrite("out:" + (string)n, json);
}

flushOutbox()
{
    list ks = llLinksetDataFindKeys("^out:", 0, 1);
    if (ks == []) return;
    string k = llList2String(ks, 0);
    req("POST", "/event", llLinksetDataRead(k), "eventout", k);
}

hello()
{
    string body = llList2Json(JSON_OBJECT,
        ["key", (string)llGetKey(), "label", LABEL,
         "region", llGetRegionName(), "list", LIST_NAME]);
    req("POST", "/sat-hello", body, "hello", "");
}

subscribe(key id, string name, string listName)
{
    list kv = ["type", "sub", "uuid", (string)id, "name", name, "src", LABEL];
    if (listName != "") kv += ["list", listName];
    string ev = llList2Json(JSON_OBJECT, kv);
    req("POST", "/event", ev, "event", ev);
    string extra = "";
    if (listName != "") extra = " (" + listName + " list)";
    llRegionSayTo(id, 0, "Welcome to " + NEWSLETTER_NAME + extra
        + "! You'll receive event notices and packages from now on.");
}

default
{
    state_entry()
    {
        g_dlgChan = -1 - (integer)llFrand(2000000000.0);
        llListen(g_dlgChan, "", NULL_KEY, "");
        llSetTimerEvent(HEARTBEAT);
        hello();
        llOwnerSay(NEWSLETTER_NAME + " satellite \"" + LABEL
            + "\" starting — connecting to " + SERVER_URL);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        if (c & (CHANGED_REGION_START | CHANGED_REGION | CHANGED_TELEPORT)) hello();
    }

    touch_start(integer n)
    {
        key who = llDetectedKey(0);
        if (who == llGetOwner())
        {
            string t = "server: " + SERVER_URL + "\nlabel: " + LABEL;
            if (LIST_NAME != "") t += "\npinned list: " + LIST_NAME;
            if (g_lastHello > 0) t += "\nlast contact: "
                + (string)(llGetUnixTime() - g_lastHello) + "s ago";
            else t += "\nlast contact: never";
            llDialog(who, NEWSLETTER_NAME + " satellite\n" + t,
                ["Sync", "Close"], g_dlgChan);
            return;
        }
        string blurb = NEWSLETTER_NAME + "\n\nSubscribe for event invitations "
            + "and gift packages — no group slot needed!";
        if (LIST_NAME != "") blurb += "\nThis board signs you up for: " + LIST_NAME;
        blurb += "\n\n\"Get Latest\" sends you the newest package.";
        llDialog(who, blurb, ["Subscribe", "Get Latest", "Unsubscribe"], g_dlgChan);
    }

    listen(integer chan, string name, key id, string msg)
    {
        if (chan != g_dlgChan) return;

        if (id == llGetOwner() && msg == "Sync")
        {
            hello();
            llOwnerSay("Syncing with hub...");
            return;
        }
        if (id == llGetOwner() && msg == "Close") return;

        if (msg == "Subscribe")
        {
            if (LIST_NAME != "")
            {
                subscribe(id, name, LIST_NAME); // pinned-list board
                return;
            }
            string lj = llLinksetDataRead("lists");
            if (lj == "" || llJsonValueType(lj, [0]) == JSON_INVALID)
            {
                subscribe(id, name, "");
                return;
            }
            list btns = ["Everything"];
            integer li = 0;
            while (llJsonValueType(lj, [li]) != JSON_INVALID
                && llGetListLength(btns) < 12)
            {
                btns += llJsonGetValue(lj, [li]);
                li++;
            }
            llDialog(id, NEWSLETTER_NAME
                + "\n\nWhich newsletter would you like?\n(\"Everything\" = all of them.)",
                btns, g_dlgChan);
        }
        else if (msg == "Everything")
        {
            subscribe(id, name, "");
        }
        else if (msg == "Unsubscribe")
        {
            string ev = llList2Json(JSON_OBJECT,
                ["type", "unsub", "uuid", (string)id, "name", name, "src", LABEL]);
            req("POST", "/event", ev, "event", ev);
            llRegionSayTo(id, 0, "You have been unsubscribed from "
                + NEWSLETTER_NAME + ".");
        }
        else if (msg == "Get Latest")
        {
            req("POST", "/request-latest",
                llList2Json(JSON_OBJECT, ["uuid", (string)id, "src", LABEL]),
                "latest", (string)id);
        }
        else
        {
            // list-picker button?
            string lj2 = llLinksetDataRead("lists");
            integer j = 0;
            while (llJsonValueType(lj2, [j]) != JSON_INVALID)
            {
                if (llJsonGetValue(lj2, [j]) == msg)
                {
                    subscribe(id, name, msg);
                    return;
                }
                j++;
            }
        }
    }

    http_response(key rid, integer status, list meta, string body)
    {
        integer idx = llListFindList(g_http, [rid]);
        if (idx == -1) return;
        string type = llList2String(g_http, idx + 1);
        string aux = llList2String(g_http, idx + 2);
        g_http = llDeleteSubList(g_http, idx, idx + 2);

        if (status != 200)
        {
            if (type == "event") queueOutbox(aux);
            else if (type == "latest") llRegionSayTo((key)aux, 0,
                NEWSLETTER_NAME + ": the hub is unreachable right now — "
                + "please try again in a few minutes.");
            else if (type == "hello")
                llOwnerSay("WARNING: hub unreachable (HTTP " + (string)status + ").");
            return;
        }

        if (type == "hello")
        {
            g_lastHello = llGetUnixTime();
            if (llJsonValueType(body, ["listNames"]) == JSON_ARRAY)
                llLinksetDataWrite("lists", llJsonGetValue(body, ["listNames"]));
            if (llJsonGetValue(body, ["listOk"]) == JSON_FALSE)
                llOwnerSay("WARNING: pinned list \"" + LIST_NAME
                    + "\" does not exist on the hub — subscribers here will "
                    + "join without a list until you create it or fix LIST_NAME.");
            flushOutbox();
        }
        else if (type == "eventout")
        {
            llLinksetDataDelete(aux);
            flushOutbox();
        }
        else if (type == "latest")
        {
            if (llJsonGetValue(body, ["ok"]) == JSON_TRUE)
                llRegionSayTo((key)aux, 0, NEWSLETTER_NAME + ": \""
                    + llJsonGetValue(body, ["name"])
                    + "\" is on its way from our main kiosk — it will "
                    + "arrive in a few moments!");
            else llRegionSayTo((key)aux, 0,
                NEWSLETTER_NAME + ": no packages have been published yet.");
        }
    }

    timer()
    {
        hello();
    }
}
