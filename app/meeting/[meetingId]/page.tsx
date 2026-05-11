'use client'

import React, { useMemo, useState } from 'react'
import { useMeetingDetail } from './hooks/useMeetingDetail'
import MeetingHeader from './components/MeetingHeader'
import MeetingInfo from './components/MeetingInfo'
import { Button } from '@/components/ui/button'
import ActionItems from './components/action-items/ActionItems'
import TranscriptDisplay from './components/TranscriptDisplay'
import ChatSidebar from './components/ChatSidebar'
import CustomAudioPlayer from './components/AudioPlayer'
import { AlertTriangle, Eye, EyeOff, TrendingDown, Lightbulb, BarChart2, CheckCircle2 } from 'lucide-react'
import
    {
        AreaChart,
        Area,
        XAxis,
        YAxis,
        CartesianGrid,
        Tooltip,
        ResponsiveContainer,
        ReferenceLine,
        Legend
    } from 'recharts'

const SPEAKER_COLORS = [ '#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#f472b6' ]

// ✅ FIX: Parse riskAnalysis whether it's a JSON string, plain HTML string, or object
function parseRiskAnalysis ( raw: any ): { html: string; criticalRisks: string[]; blindSpots: string[]; confidenceScore: number } | null
{
    if ( !raw ) return null
    try
    {
        const parsed = typeof raw === 'string' ? JSON.parse( raw ) : raw
        return {
            html: parsed.html || '',
            criticalRisks: parsed.criticalRisks || [],
            blindSpots: parsed.blindSpots || [],
            confidenceScore: parsed.confidenceScore ?? 0,
        }
    } catch
    {
        // It was a plain HTML string, not JSON
        return { html: typeof raw === 'string' ? raw : '', criticalRisks: [], blindSpots: [], confidenceScore: 0 }
    }
}

function ConfidenceMeter ( { score }: { score: number } )
{
    const pct = Math.max( 0, Math.min( 100, score ) )
    const color = pct >= 70 ? '#34d399' : pct >= 40 ? '#fbbf24' : '#f87171'
    return (
        <div className="flex items-center gap-3 mt-4">
            <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">Confidence</span>
            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-700"
                    style={ { width: `${ pct }%`, backgroundColor: color } }
                />
            </div>
            <span className="text-xs font-bold tabular-nums" style={ { color } }>{ pct }%</span>
        </div>
    )
}

function RiskAnalysisPanel ( { raw }: { raw: any } )
{
    const [ expanded, setExpanded ] = useState( false )
    const data = parseRiskAnalysis( raw )
    if ( !data ) return null

    return (
        <div className="rounded-2xl overflow-hidden border border-red-500/20 bg-gradient-to-br from-red-950/30 to-gray-900/60 backdrop-blur-sm shadow-xl shadow-red-900/10">
            {/* Header */ }
            <div className="flex items-center justify-between px-6 py-4 border-b border-red-500/10">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
                        <AlertTriangle className="h-4 w-4 text-red-400" />
                    </div>
                    <div>
                        <h2 className="text-sm font-semibold text-red-300 tracking-wide">Devil's Advocate</h2>
                        <p className="text-xs text-gray-500">AI-generated critical risk assessment</p>
                    </div>
                </div>
                <button
                    onClick={ () => setExpanded( v => !v ) }
                    className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors"
                >
                    { expanded ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" /> }
                    { expanded ? 'Collapse' : 'Expand' }
                </button>
            </div>

            <div className="p-6 space-y-5">
                {/* Confidence meter always visible */ }
                <ConfidenceMeter score={ data.confidenceScore } />

                {/* Critical risks — pill cards */ }
                { data.criticalRisks.length > 0 && (
                    <div>
                        <div className="flex items-center gap-2 mb-3">
                            <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                            <span className="text-xs font-semibold text-red-400 uppercase tracking-widest">Critical Risks</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            { data.criticalRisks.map( ( risk, i ) => (
                                <span
                                    key={ i }
                                    className="text-xs px-3 py-1.5 rounded-full border border-red-500/20 bg-red-500/5 text-red-300"
                                >
                                    { risk }
                                </span>
                            ) ) }
                        </div>
                    </div>
                ) }

                {/* Blind spots */ }
                { data.blindSpots.length > 0 && (
                    <div>
                        <div className="flex items-center gap-2 mb-3">
                            <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
                            <span className="text-xs font-semibold text-amber-400 uppercase tracking-widest">Blind Spots</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            { data.blindSpots.map( ( spot, i ) => (
                                <span
                                    key={ i }
                                    className="text-xs px-3 py-1.5 rounded-full border border-amber-500/20 bg-amber-500/5 text-amber-300"
                                >
                                    { spot }
                                </span>
                            ) ) }
                        </div>
                    </div>
                ) }

                {/* Full HTML analysis — collapsible */ }
                { expanded && data.html && (
                    <div
                        className="prose prose-sm prose-invert max-w-none mt-2 pt-4 border-t border-white/5
                        prose-p:text-gray-300 prose-p:leading-relaxed
                        prose-h3:text-white prose-h3:font-semibold prose-h3:text-sm
                        prose-ul:list-disc prose-ul:pl-4 prose-li:text-gray-400 prose-li:mb-1
                        prose-strong:text-white"
                        dangerouslySetInnerHTML={ { __html: data.html } }
                    />
                ) }
            </div>
        </div>
    )
}

function SentimentChart ( { sentimentData, speakers }: { sentimentData: any[]; speakers: string[] } )
{
    return (
        <div className="rounded-2xl border border-white/5 bg-gray-900/60 backdrop-blur-sm p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <BarChart2 className="h-4 w-4 text-blue-400" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-white">Emotional Arc</h3>
                    <p className="text-xs text-gray-500">Sentiment per speaker over time</p>
                </div>
            </div>
            <div className="h-[240px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={ sentimentData }>
                        <defs>
                            { speakers.map( ( speaker, index ) => (
                                <linearGradient key={ speaker } id={ `grad-${ speaker }` } x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={ SPEAKER_COLORS[ index % SPEAKER_COLORS.length ] } stopOpacity={ 0.25 } />
                                    <stop offset="95%" stopColor={ SPEAKER_COLORS[ index % SPEAKER_COLORS.length ] } stopOpacity={ 0 } />
                                </linearGradient>
                            ) ) }
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                        <XAxis
                            dataKey="timestamp"
                            tickFormatter={ ( val ) => `${ Math.floor( val / 60 ) }m` }
                            stroke="#444"
                            fontSize={ 11 }
                            tickLine={ false }
                        />
                        <YAxis domain={ [ -1, 1 ] } hide />
                        <Tooltip
                            contentStyle={ { backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', fontSize: 12 } }
                            itemStyle={ { color: '#cbd5e1' } }
                            labelFormatter={ ( label ) => `${ Math.floor( Number( label ) / 60 ) }m ${ String( Number( label ) % 60 ).padStart( 2, '0' ) }s` }
                        />
                        <Legend
                            verticalAlign="top"
                            height={ 32 }
                            wrapperStyle={ { fontSize: 11, paddingBottom: 8 } }
                        />
                        <ReferenceLine y={ 0 } stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
                        { speakers.map( ( speaker, index ) => (
                            <Area
                                key={ speaker }
                                type="monotone"
                                dataKey={ speaker }
                                name={ speaker }
                                stroke={ SPEAKER_COLORS[ index % SPEAKER_COLORS.length ] }
                                strokeWidth={ 2 }
                                fill={ `url(#grad-${ speaker })` }
                                connectNulls
                                dot={ false }
                                activeDot={ { r: 4, strokeWidth: 0 } }
                            />
                        ) ) }
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    )
}

function TabButton ( { label, active, onClick }: { label: string; active: boolean; onClick: () => void } )
{
    return (
        <button
            onClick={ onClick }
            className={ `relative px-5 py-2.5 text-sm font-medium transition-all duration-200 ${ active
                    ? 'text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }` }
        >
            { label }
            { active && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />
            ) }
        </button>
    )
}

function MeetingDetail ()
{
    const {
        meetingId,
        isOwner,
        userChecked,
        chatInput,
        setChatInput,
        messages,
        showSuggestions,
        activeTab,
        setActiveTab,
        meetingData,
        loading,
        handleSendMessage,
        handleSuggestionClick,
        handleInputChange,
        deleteActionItem,
        addActionItem,
        displayActionItems,
        meetingInfoData
    } = useMeetingDetail()

    const sentimentSpeakers = useMemo( () =>
    {
        if ( !meetingData?.sentimentData || !Array.isArray( meetingData.sentimentData ) || meetingData.sentimentData.length === 0 ) return []
        const firstPoint = meetingData.sentimentData[ 0 ]
        return Object.keys( firstPoint ).filter( key => key !== 'timestamp' && key !== 'name' )
    }, [ meetingData ] )

    return (
        <div className="min-h-screen bg-[#090c10] text-white">
            <MeetingHeader
                title={ meetingData?.title || 'Meeting' }
                meetingId={ meetingId }
                summary={ meetingData?.summary }
                actionItems={ meetingData?.actionItems?.map( ( item: any ) => `• ${ item.text }` ).join( '\n' ) || '' }
                isOwner={ isOwner }
                isLoading={ !userChecked }
            />

            <div className="flex h-[calc(100vh-73px)]">
                {/* Main content */ }
                <div className={ `flex-1 overflow-auto pb-32 ${ !userChecked ? '' : !isOwner ? 'max-w-4xl mx-auto' : '' }` }>
                    <div className="px-6 pt-6">
                        <MeetingInfo meetingData={ meetingInfoData } />
                    </div>

                    {/* Tabs */ }
                    <div className="px-6 mt-2">
                        <div className="flex border-b border-white/5">
                            <TabButton label="Summary" active={ activeTab === 'summary' } onClick={ () => setActiveTab( 'summary' ) } />
                            <TabButton label="Transcript" active={ activeTab === 'transcript' } onClick={ () => setActiveTab( 'transcript' ) } />
                        </div>
                    </div>

                    <div className="px-6 py-6">
                        {/* ── SUMMARY TAB ── */ }
                        { activeTab === 'summary' && (
                            <>
                                { loading ? (
                                    <LoadingCard message="Loading meeting data…" />
                                ) : meetingData?.processed ? (
                                    <div className="space-y-4">

                                        {/* Summary card */ }
                                        { meetingData.summary && (
                                            <div className="rounded-2xl border border-white/5 bg-gray-900/60 backdrop-blur-sm p-6 shadow-xl">
                                                <div className="flex items-center gap-3 mb-4">
                                                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                                                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                                                    </div>
                                                    <h3 className="text-sm font-semibold text-white">Meeting Summary</h3>
                                                </div>
                                                <p className="text-sm text-gray-400 leading-relaxed">{ meetingData.summary }</p>
                                            </div>
                                        ) }

                                        {/* ✅ Risk analysis — now properly parsed */ }
                                        { ( meetingData as any ).riskAnalysis && (
                                            <RiskAnalysisPanel raw={ ( meetingData as any ).riskAnalysis } />
                                        ) }

                                        {/* Sentiment chart */ }
                                        { ( meetingData as any ).sentimentData?.length > 0 && (
                                            <SentimentChart
                                                sentimentData={ ( meetingData as any ).sentimentData }
                                                speakers={ sentimentSpeakers }
                                            />
                                        ) }

                                        {/* Action items */ }
                                        { !userChecked ? (
                                            <SkeletonCard />
                                        ) : isOwner && displayActionItems.length > 0 ? (
                                            <ActionItems
                                                actionItems={ displayActionItems }
                                                onDeleteItem={ deleteActionItem }
                                                onAddItem={ addActionItem }
                                                meetingId={ meetingId }
                                            />
                                        ) : !isOwner && displayActionItems.length > 0 ? (
                                            <div className="rounded-2xl border border-white/5 bg-gray-900/60 p-6">
                                                <h3 className="text-sm font-semibold text-white mb-4">Action Items</h3>
                                                <div className="space-y-2">
                                                    { displayActionItems.map( ( item ) => (
                                                        <div key={ item.id } className="flex items-start gap-3">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 flex-shrink-0" />
                                                            <p className="text-sm text-gray-400">{ item.text }</p>
                                                        </div>
                                                    ) ) }
                                                </div>
                                            </div>
                                        ) : null }
                                    </div>
                                ) : (
                                    <LoadingCard message="Processing meeting with AI…" sub="You'll receive an email when ready" />
                                ) }
                            </>
                        ) }

                        {/* ── TRANSCRIPT TAB ── */ }
                        { activeTab === 'transcript' && (
                            <>
                                { loading ? (
                                    <LoadingCard message="Loading transcript…" />
                                ) : meetingData?.transcript ? (
                                    <TranscriptDisplay transcript={ meetingData.transcript } />
                                ) : (
                                    <div className="rounded-2xl border border-white/5 bg-gray-900/60 p-10 text-center">
                                        <p className="text-sm text-gray-500">No transcript available</p>
                                    </div>
                                ) }
                            </>
                        ) }
                    </div>
                </div>

                {/* Sidebar */ }
                { !userChecked ? (
                    <div className="w-80 border-l border-white/5 p-4 bg-gray-900/40">
                        <SkeletonCard />
                    </div>
                ) : isOwner && (
                    <ChatSidebar
                        messages={ messages }
                        chatInput={ chatInput }
                        showSuggestions={ showSuggestions }
                        onInputChange={ handleInputChange }
                        onSendMessage={ handleSendMessage }
                        onSuggestionClick={ handleSuggestionClick }
                    />
                ) }
            </div>

            <CustomAudioPlayer recordingUrl={ meetingData?.recordingUrl } isOwner={ isOwner } />
        </div>
    )
}

function LoadingCard ( { message, sub }: { message: string; sub?: string } )
{
    return (
        <div className="rounded-2xl border border-white/5 bg-gray-900/60 p-10 text-center">
            <div className="inline-block w-7 h-7 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-4" />
            <p className="text-sm text-gray-400">{ message }</p>
            { sub && <p className="text-xs text-gray-600 mt-1">{ sub }</p> }
        </div>
    )
}

function SkeletonCard ()
{
    return (
        <div className="rounded-2xl border border-white/5 bg-gray-900/40 p-6 animate-pulse">
            <div className="h-3 bg-white/5 rounded w-1/4 mb-4" />
            <div className="space-y-2">
                <div className="h-2.5 bg-white/5 rounded w-3/4" />
                <div className="h-2.5 bg-white/5 rounded w-1/2" />
            </div>
        </div>
    )
}

export default MeetingDetail