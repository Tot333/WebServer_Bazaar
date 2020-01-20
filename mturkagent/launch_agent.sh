#!/bin/bash
cd "$(dirname "$0")"

roomname=$1;

jar_name="ReboAgent.jar"

echo $jar_name
echo $roomname

DISPLAY=':19' java -jar $jar_name --room=$roomname --launch


