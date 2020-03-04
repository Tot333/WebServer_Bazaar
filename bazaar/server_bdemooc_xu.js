const fs = require('fs');
const path = require('path');
const os = require('os');

var mysql      = require('mysql');
var mysql_auth = {
      host     : 'nodechat',
      user     : 'root',
      password : 'smoot',
      port     : 3306
    };
var connection;
var bodyParser = require('body-parser');
var localPort = 80;
var localURL = "/bazaar";

function handleDisconnect() {
  connection = mysql.createConnection(mysql_auth); // Recreate the connection, since
                                                  // the old one cannot be reused.

  connection.connect(function(err) {              // The server is either down
    if(err) {                                     // or restarting (takes a while sometimes).
      console.log('error when connecting to db:', err);
      setTimeout(handleDisconnect, 2000); // We introduce a delay before attempting to reconnect,
    }                                     // to avoid a hot loop, and to allow our node script to
  });                                     // process asynchronous requests in the meantime.
                                          // If you're also serving http, display a 503 error.
  connection.on('error', function(err) {
    console.log('db error', err);
    if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
        handleDisconnect();                         // lost due to either server restart, or a
    } else {
	    console.log('unknown db connection error', err)                      // connnection idle timeout (the wait_timeout
	    handleDisconnect();
    }
  });
}

handleDisconnect();

var numUsers = {};
var chatroom_locked = false;

var csv = require('csv');
const exec = require('child_process').exec;

var express = require('express');
var app = express();
app.use(express.static('public'));
var server = require('http').createServer(app);
var io = require('socket.io')(server, {path: '/bazsocket'});

server.listen(localPort);
io.set('log level', 1);
app.use(bodyParser.urlencoded());

app.get('/bazaar/room_status_all', function (req, res)
{
    console.log("app.get('/bazaar/room_status_all')");
    var connection = mysql.createConnection(mysql_auth);
    var query = 'SELECT name from nodechat.room';
    console.log(query);
    connection.query(query, function(err, rows, fields) {
        if(err) {
            console.log(err);
            res.send(500, "<body><h2>Error</h2><p>Couldn't fetch data</p></body>");
        } else {
            var num_list = "";
            for (var i = 0; i < rows.length; i++) num_list += "<p>"+rows[i].name+"</p>";
            res.send("<body>"+num_list+"</body>");
        }
    });
});

app.get('/bazaar/room_status*', function (req, res)
{
    console.log("app.get('/bazaar/room_status*')");
    var connection = mysql.createConnection(mysql_auth);
    var query = 'SELECT name from nodechat.room where name='+mysql.escape(req.query.roomId);
    console.log(query);
    connection.query(query, function(err, rows, fields) {
        if(err)
        {
            console.log(err);
            res.send(500, "<body><h2>Error</h2><p>Couldn't fetch data</p></body>");
        }
        else if (rows.length==0)
        {
            res.send("Has not been used");
        }
        else {
            res.send("Has already been used");
        }
    });
});

app.get('/bazaar/chat*', function (req, res)
{
    var html_page = 'index';
    
    if(req.query.html != undefined) 
        html_page = req.query.html;

	res.sendfile(html_page + '.html');
});


app.get('/bazaar/observe/*', function (req, res)
{
    res.sendfile('index.html');
});


app.get('/bazaar/data/*', function (req, res)
{
    groups = /\/data\/([^\/]+)/.exec(req.url)	  
    room = groups[1];

    var query = "SELECT DATE_FORMAT(m.timestamp, '%Y-%m-%d'), DATE_FORMAT(m.timestamp, '%H:%i:%s'), m.type, m.content, m.username, r.name "
    + "from nodechat.message as m "
    + "join nodechat.room as r "
    + "on m.roomid=r.id "
    + "where r.name=\""+room+"\""
    +" order by timestamp";

    exportCSV(room, res, query);
});

app.get('/bazaar/AllData', function (req, res)
{
    var query = "SELECT DATE_FORMAT(m.timestamp, '%Y-%m-%d'), DATE_FORMAT(m.timestamp, '%H:%i:%s'), m.type, m.content, m.username, r.name "
    + "from nodechat.message as m "
    + "join nodechat.room as r "
    + "on m.roomid=r.id "
    +" order by r.name, timestamp";

    exportCSV("AllData", res, query);
});

// sockets by username
var user_sockets = {};

// usernames which are currently connected to each chat room
var usernames = {};

// user_perspectives
var user_perspectives = {};
// rooms which are currently available in chat
var rooms = [];

function isBlank(str)
{
    return !str || /^\s*$/.test(str)
}
var header_stuff = "<head>\n"+
"\t<link href='http://fonts.googleapis.com/css?family=Oxygen' rel='stylesheet' type='text/css'>\n"+
"\t<link href='http://ankara.lti.cs.cmu.edu/include/discussion.css' rel='stylesheet' type='text/css'>\n"+
"</head>";

function exportCSV(room, res, query)
{
    var connection = mysql.createConnection(mysql_auth);
    
    connection.query(query, function(err, rows, fields) 
    {

        if(err) {
            console.log(err);
            res.send(501, header_stuff+"<body><h2>Export Error</h2><p>Couldn't fetch data for room '"+room+"':</p><pre>"+err+"</pre></body>");
        } else if(rows.length == 0) {
            res.send(404, header_stuff+"<body><h2>Empty Room</h2><p>Couldn't fetch data for empty room '"+room+"'.</p></body>");
        } else {
            const filename = path.join('output.csv');

            var csv = 'Chatroom;Datum;Uhrzeit;Nachricht;User;Typ\n';
            rows.forEach(function(d) {
                const row = []; // a new array for each row of data
                row.push(d.name);
                row.push(d["DATE_FORMAT(m.timestamp, '%Y-%m-%d')"]);
                row.push(d["DATE_FORMAT(m.timestamp, '%H:%i:%s')"]);
                row.push(d.content);
                row.push(d.username);
                row.push(d.type);

                var tmp = row.join(";");

                csv += tmp + "\n";
            });


            fs.writeFileSync(filename, csv);

            res.set('Content-Type', 'text/csv');
            res.header("Content-Disposition", "attachment; filename=output.csv");
            res.sendfile(filename);
        }
    });
}

function loadHistory(socket, secret)
{
    if(!socket.temporary)
    {
        var id = null;
        if(socket.room in usernames && socket.username in usernames[socket.room])
        {
	        id = usernames[socket.room][socket.username];
        }

        var perspective = null;
        if(socket.room in user_perspectives && socket.username in user_perspectives[socket.room])
        {
            perspective = user_perspectives[socket.room][socket.username];
        }
 
        
        connection.query('insert ignore into nodechat.room set name='+connection.escape(socket.room)+', created=NOW(), modified=NOW(), comment="auto-created";', function(err, rows, fields)
        {    
            setTimeout( function(socket)
            {
                var connection = mysql.createConnection(mysql_auth);
                 
                connection.query('SELECT m.timestamp, m.type, m.content, m.username from nodechat.message '
                +'as m join nodechat.room as r on m.roomid=r.id '
                +'where r.name='+connection.escape(socket.room)+' and not(m.type like "private") order by timestamp', function(err, rows, fields) 
                {
                    if (err) 
                        console.log(err);
                        
                    socket.emit('dump_history', rows);
		    
                    if(!secret)
                    {
                        io.sockets.in(socket.room).emit('updatepresence', socket.username, 'join', id, perspective);
                        logMessage(socket, "join", "presence");
                    }
                });
            
                connection.end()
            }, 100, socket);

        });
    }
    else if(!secret)
    {
	    io.sockets.in(socket.room).emit('updatepresence', socket.username, 'join', id, perspective);
    }
}

function logEssay(socket, content, type)
{    
    if(socket.temporary) 
    	return;

    connection.query('update nodechat.room set modified=now() where room.name='+connection.escape(socket.room)+';', function(err, rows, fields)
    {
        if (err) 
            console.log(err);
    });
    
    endpoint = "unknown"

    if(socket.handshake)
        endpoint = socket.handshake.address;
        
    query = 'insert into nodechat.message (roomid, username, useraddress, userid, content, type, timestamp)' 
                    +'values ((select id from nodechat.room where name='+connection.escape(socket.room)+'), '
                    +''+connection.escape(socket.username)+', '+connection.escape(endpoint.address+':'+endpoint.port)+', '
                    +connection.escape(socket.Id) +', '+connection.escape(content)+', '+connection.escape(type)+', now());';
    
    connection.query(query, function(err, rows, fields) 
    {
        if (err) 
        	console.log(err);
    });
}

function logMessage(socket, content, type)
{    
    //if(chatroom_locked)
    //    return;

    if(socket.temporary) 
    	return;

    connection.query('update nodechat.room set modified=now() where room.name='+connection.escape(socket.room)+';', function(err, rows, fields)
    {
        if (err) 
            console.log(err);
    });
    
    endpoint = "unknown"

    if(socket.handshake)
        endpoint = socket.handshake.address;
        
    query = 'insert into nodechat.message (roomid, username, useraddress, userid, content, type, timestamp)' 
                    +'values ((select id from nodechat.room where name='+connection.escape(socket.room)+'), '
                    +''+connection.escape(socket.username)+', '+connection.escape(endpoint.address+':'+endpoint.port)+', '
                    +connection.escape(socket.Id) +', '+connection.escape(content)+', '+connection.escape(type)+', now());';
    
    connection.query(query, function(err, rows, fields) 
    {
        if (err) 
        	console.log(err);
    });
    
}

// if it is a chatbotroom Check on join if chatbot already done
// if so then lock the chatroom textarea
function checkChatbotFinished(room, callback) {
	query = 'SELECT * FROM nodechat.message as m JOIN nodechat.room as r on m.roomid=r.id WHERE r.name='+connection.escape(room)
                + ' AND m.content=\'leave\' AND m.type=\'presence\' AND m.username=\'Rebo\';';
                
    connection.query(query, function(err, results) 
    {
        if (err) 
            console.log(err);

        return callback(results)
    });
}

function checkEssayAlreadyWritten(room, callback) {
    query = 'SELECT * FROM nodechat.message as m JOIN nodechat.room as r on m.roomid=r.id WHERE r.name='+connection.escape(room)
    + ' AND m.type=' + connection.escape('text') + ';';
    
    connection.query(query, function(err, results) 
    {
        if (err) 
            console.log(err);

        return callback(results)
    });
}


function checkFirstJoin(room, callback) {
    count = 0;

	query = 'SELECT * FROM nodechat.message as m JOIN nodechat.room as r on m.roomid=r.id WHERE r.name='+connection.escape(room);
    		//	+ ' AND m.content=\'join\' AND m.type=\'presence\';';


    connection.query(query, function(err, results) 
    {
        if (err) 
          console.log(err);

        return callback(results)
    });
}

io.sockets.on('connection', function (socket) {
	socket.on('snoop', function(room, username, temporary, type, perspective){
        var id = 1;
        if(isBlank(username)) {
	        origin = socket.handshake.address
	        username = "Guest "+(origin.address+origin.port).substring(6).replace(/\./g, '');
	    }
	   
        if(isBlank(room))
            room = "Limbo"

        //don't log anything to the db if this flag is set
        socket.temporary = temporary;

        // store the username in the socket session for this client
        socket.username = username;
        // store the room name in the socket session for this client
        socket.room = room;
        socket.Id = id;
        // add the client's username to the global list
        if(!usernames[room])
            usernames[room] = {};
        usernames[room][username] = id;

        if(!user_perspectives[room])
            user_perspectives[room] = {};
        user_perspectives[room][username] = perspective;

        // send client to room 1
        socket.join(room);

        if(!user_sockets[room])
            user_sockets[room] = {};
        user_sockets[room][username] = socket;
                
        loadHistory(socket, true);
	});
  
	// when the client emits 'adduser', this listens and executes
	socket.on('adduser', function(room, username, temporary, type, perspective){
        var id = 1;

        if(username != "Rebo")
	    {
	        if(room in numUsers)
			{		
	           	numUsers[room] = numUsers[room] + 1;
			}
			else
			{
				numUsers[room] = 1;
			}	
            
            if(type === "chatbot") {
                var count = 0;
                checkFirstJoin(room, function(result){
                    count = result.length;

                    if (count < 2) {
                        var script = 'sh ../mturkagent/launch_agent.sh ';
                        var command = script.concat(room);
                        exec(command, (error, stdout, stderr) => {
                            if (error) {
                            console.error(`exec error: ${error}`);
                            return;
                            }
                            console.log(`stdout: ${stdout}`);
                            console.log(`stderr: ${stderr}`);
                        });	
                    }
                });

                checkChatbotFinished(room, function(results){
                    if(results.length > 0) {
                        io.sockets.in(socket.room).emit('lockTextArea', results);
                        chatroom_locked = true;
                    }
                });
            } else if(type === "essay") {
                checkEssayAlreadyWritten(room, function(results){
                    if(results.length == null || results.length == 0) {
                        io.sockets.in(socket.room).emit('essayTypeMode', room);
                    } else if(results.length > 0) {
                        io.sockets.in(socket.room).emit('essayFinished', room);
                        chatroom_locked = true;
                    } 
                });
            }

	    }

        if(isBlank(username)) {
	        origin = socket.handshake.address
	        username = "Guest "+(origin.address+origin.port).substring(6).replace(/\./g, '');
	    }
	   
        if(isBlank(room))
            room = "Limbo"

        //don't log anything to the db if this flag is set
        socket.temporary = temporary;

        // store the username in the socket session for this client
        socket.username = username;
        // store the room name in the socket session for this client
        socket.room = room;
        socket.Id = id;
        // add the client's username to the global list
        if(!usernames[room])
            usernames[room] = {};
        usernames[room][username] = id;

        if(!user_perspectives[room])
            user_perspectives[room] = {};
        user_perspectives[room][username] = perspective;

        // send client to room 1
        socket.join(room);

        if(!user_sockets[room])
            user_sockets[room] = {};
        user_sockets[room][username] = socket;
                
        loadHistory(socket, false);
        io.sockets.in(socket.room).emit('updateusers', usernames[socket.room], user_perspectives[socket.room], "update");
	});

	socket.on('sendchat', function (data) 
	{
		logMessage(socket, data, "text");
		io.sockets.in(socket.room).emit('updatechat', socket.username, data);
    });
    
    socket.on('essaySend', function (data) 
	{
		logEssay(socket, data, "text");
		io.sockets.in(socket.room).emit('updatechat', socket.username, data);
	});

	socket.on('sendpm', function (data, to_user) 
	{
		logMessage(socket, data, "private");
		if(socket.room in user_sockets && to_user in user_sockets[socket.room])
    		user_sockets[socket.room][to_user].emit('update_private_chat', socket.username, data);
	});
	
	socket.on('sendhtml', function (data) 
	{
		logMessage(socket, data, "html");
		io.sockets.in(socket.room).emit('updatehtml', socket.username, data);
	});
 
	socket.on('ready', function (data) 
	{
		logMessage(socket, data, "ready");
		io.sockets.in(socket.room).emit('updateready', socket.username, data);
	});
	
	socket.on('global_ready', function (data) 
	{
		logMessage(socket, "global "+data, "ready");
		io.sockets.in(socket.room).emit('update_global_ready', data);
	});

	socket.on('switchRoom', function(newroom)
	{
	    if(socket.room in usernames && socket.username in usernames[socket.room])
	        delete usernames[socket.room][socket.username];
	    io.sockets.in(socket.room).emit('updateusers', usernames[socket.room]);
	    io.sockets.in(socket.room).emit('updatepresence', username,  'leave');
		
	    logMessage(socket, "leave", "presence");
	    socket.leave(socket.room);
	    // join new room, received as function parameter
	    socket.join(newroom);
	    // sent message to OLD room
	    // update socket session room title
	    socket.room = newroom;
	    
	    usernames[socket.room][socket.username] = username;
	    io.sockets.in(socket.room).emit('updateusers', usernames[socket.room]);
	    io.sockets.in(socket.room).emit('updatepresence', username, 'join');
	    
	    socket.emit('updaterooms', [room,], newroom);
	    logMessage(socket, "join", "presence");
	});

	// when the user disconnects... perform this
	socket.on('disconnect', function()
	{
        if(socket.username != "Rebo" && socket.room in numUsers)
        {
        	numUsers[socket.room] = numUsers[socket.room] - 1; 
        }

	    if(socket.room in usernames && socket.username in usernames[socket.room])
	    {
            // remove the username from global usernames list
            var id = usernames[socket.room][socket.username];
            var perspective = user_perspectives[socket.room][socket.username];
            delete usernames[socket.room][socket.username];
            if(usernames[socket.room])
            {
                // update list of users in chat, client-side
                io.sockets.in(socket.room).emit('updateusers', usernames[socket.room], user_perspectives[socket.room], "update");
                // echo globally that this client has left
                
                io.sockets.in(socket.room).emit('updatepresence', socket.username, 'leave', id, perspective);
                logMessage(socket, "leave", "presence");
            }
	    }
	    
		if(socket.room in user_sockets && socket.username in user_sockets[socket.room])
	    {
	       delete user_sockets[socket.room][socket.username];
	    }
	    
	    if(socket.room)
		  socket.leave(socket.room);
	    
	});
});
