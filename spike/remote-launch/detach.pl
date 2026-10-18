#!/usr/bin/perl
# U1 throwaway: run ARGV in a new session (setsid), detached from the ssh session.
use POSIX qw(setsid);
exit 0 if fork();
setsid() or die "setsid: $!";
exit 0 if fork();
open STDIN, '<', '/dev/null'; open STDOUT, '>', '/dev/null'; open STDERR, '>', '/dev/null';
exec @ARGV or die;
