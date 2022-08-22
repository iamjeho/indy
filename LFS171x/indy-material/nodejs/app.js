const createError = require('http-errors');
const express = require('express');
const session = require('express-session');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const config = require('./config');

const axios = require('axios')
const QR = require('qrcode')
const uuid4 = require('uuid4')
const urljoin = require('url-join')
require('dotenv').config()

const indexRouter = require('./ui/routes/index');
const apiRouter = require('./ui/routes/api');
const indyHandler = require('./indy/src/handler')({ defaultHandlers: true, eventHandlers: [] }); // () executes the function so that we can potentially have multiple indy handlers;
// const uiMessageHandlers = require('./ui/uiMessageHandlers');
// uiMessageHandlers.enableDefaultHandlers(indyHandler);

//-------------------------------------------------------------------
// STEP 1 - Set configuration values for Verity application server
//-------------------------------------------------------------------
const verityUrl = process.env["VERITY_URL"] || "https://vas.pps.evernym.com"
const domainDid = process.env["DOMAIN_DID"]
const xApiKey = process.env["X_API_KEY"]
const credDefId = process.env["CREDENTIAL_DEFINITION_ID"]

// Verify that .env variables are set
let error = false;
if (!verityUrl) {
	console.log("The 'VERITY_URL' environment variable must be set.")
	error = true;
}
if (!domainDid) {
	console.log("The 'DOMAIN_DID' environment variable must be set.")
	error = true;
}
if (!xApiKey) {
	console.log("The 'X_API_KEY' environment variable must be set.")
	error = true;
}
if (!credDefId) {
	console.log("The 'CREDENTIAL_DEFINITION_ID' environment variable is not set.")
	error = true;
}
if (error) {
	process.exit(1);
}

const app = express();
app.use(express.json())
require('express-ws')(app);

let websocket;
let logsBeforeReady = [];

// view engine setup
app.set('views', path.join(__dirname, 'ui/views'));
app.set('view engine', 'ejs');

const FileStore = require('session-file-store')(session);
app.use(session({
    name: `server-session-cookie-id-for-${config.walletName}`,
    secret: config.sessionSecret,
    saveUninitialized: true,
    resave: true,
    rolling: true,
    store: new FileStore()
}));

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'ui/public')));

app.use('/', indexRouter);
app.use('/api', apiRouter);
app.post('/indy', indyHandler.middleware);

/**
 * Send message to browser over websocket
 *
 * @param data
 */
 async function wsSend(data) {
	if (websocket) {
		console.log("wsSend=>", data);
		await websocket.send(JSON.stringify(data));
	}
	else {
		logsBeforeReady.push(data);
	}
}

app.ws('/', function (ws, req) {
	websocket = ws;
	ws.on('message', function (msg) {
		console.log("ws message =", msg);
		while (logsBeforeReady.length > 0) {
			wsSend(logsBeforeReady.shift());
		}
		if (msg == "info") {
			wsSend({ type: "info", data: { verityUrl, domainDid, webhookUrl, credDefId, credentialData } });
		}
	});
});

// Verity Application Server will send REST API callbacks to this endpoint
app.post('/webhook', async (req, res) => {
	const message = req.body
	const threadId = message['~thread'] ? message['~thread'].thid : null
	console.log('Got message on the webhook')
	console.log(`${ANSII_GREEN}${JSON.stringify(message, null, 4)}${ANSII_RESET}`)
	res.status(202).send('Accepted')

	// Handle received message differently based on the message type
	switch (message['@type']) {
		case 'did:sov:123456789abcdefghi1234;spec/configs/0.6/COM_METHOD_UPDATED':
			await wsSend({ type: "log", data: "Webhook updated" })
			webhookResolve('webhook updated')
			break

		case 'did:sov:123456789abcdefghi1234;spec/update-configs/0.6/status-report':
			await wsSend({ type: "log", data: "Configuration updated" })
			updateConfigsMap.get(threadId)('config updated')
			break

		case 'did:sov:123456789abcdefghi1234;spec/relationship/1.0/created':
			await wsSend({ type: "log", data: "Connection created" })
			relCreateMap.get(threadId)(message.did)
			break

		case 'did:sov:123456789abcdefghi1234;spec/relationship/1.0/invitation':
			await wsSend({ type: "log", data: "Connection invitation created" })
			relInvitationMap.get(threadId)(message.inviteURL)
			break

		case 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/connections/1.0/request-received':
			await wsSend({ type: "log", data: "Connection request received" })
			break

		case 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/connections/1.0/response-sent':
			await wsSend({ type: "log", data: "Connection accepted for " + message.myDID })
			connectionAccepted.get(message.myDID)('connection accepted')
			break

		case 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/trust_ping/1.0/sent-response':
			break

		case 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/out-of-band/1.0/relationship-reused':
			console.log("Connection already exists for relationship: ", message.relationship);
			await wsSend({ type: "log", data: "Connection already exists for " + message.relationship })
			const did = relationshipDid;
			relationshipDid = message.relationship;
			await connectionAccepted.get(did)('reuse')
			break;

		case 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/issue-credential/1.0/sent':
			if (message.msg['credentials~attach']) {
				await wsSend({ type: "log", data: "Credential issued" })
				await issueCredentialMap.get(threadId)('credential issued')
			}
			else {
				await wsSend({ type: "log", data: "Credential sent" })
			}
			break

		default:
			if (message.description.code == "rejection") {
				await wsSend({ type: "log", data: "Credential rejected" })
				await issueCredentialMap.get(threadId)('credential rejected')
			}
			else {
				console.log(`Unexpected message type ${message['@type']}`)
			}
	}
})

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
